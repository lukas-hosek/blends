"use strict";

/*
 * Embeds a Display P3 ICC profile into encoded PNG, JPEG and WebP files.
 *
 * Browsers write the correct P3 pixel values from a display-p3 canvas but leave the
 * file untagged. Viewers then assume sRGB and show the image oversaturated, so the
 * profile has to be added after encoding.
 */
(function (Blends) {

	/*
	 * ICC v4 display profile: Display P3 primaries, D65 white chromatically adapted
	 * to the D50 profile connection space with the Bradford transform, and the sRGB
	 * transfer curve as a parametric curve (type 3). 532 bytes.
	 */
	const DISPLAY_P3_PROFILE_BASE64 = [
		"AAACFAAAAAAEMAAAbW50clJHQiBYWVogB+oAAQABAAAAAAAAYWNzcAAAAAAAAAAAAAAAAAAA",
		"AAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y0AAAAACcnvic2ERgsIunkJfg7k7gAAAAAAAAAA",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAwY3BydAAAASwAAABMd3RwdAAA",
		"AXgAAAAUY2hhZAAAAYwAAAAsclhZWgAAAbgAAAAUZ1hZWgAAAcwAAAAUYlhZWgAAAeAAAAAU",
		"clRSQwAAAfQAAAAgZ1RSQwAAAfQAAAAgYlRSQwAAAfQAAAAgbWx1YwAAAAAAAAABAAAADGVu",
		"VVMAAAAUAAAAHABEAGkAcwBwAGwAYQB5ACAAUAAzbWx1YwAAAAAAAAABAAAADGVuVVMAAAAw",
		"AAAAHABOAG8AIABjAG8AcAB5AHIAaQBnAGgAdAAsACAAdQBzAGUAIABmAHIAZQBlAGwAeVhZ",
		"WiAAAAAAAAD21gABAAAAANMtc2YzMgAAAAAAAQxCAAAF3v//8yUAAAeTAAD9kP//+6H///2i",
		"AAAD3AAAwG5YWVogAAAAAAAAg98AAD2/////u1hZWiAAAAAAAABKvwAAsTcAAAq5WFlaIAAA",
		"AAAAACg4AAARCwAAyLlwYXJhAAAAAAADAAAAAmZmAADypwAADVkAABPQAAAKWw==",
	].join("");

	const PROFILE_DESCRIPTION = "Display P3";

	let profileBytesPromise = null;
	let compressedProfilePromise = null;

	function getProfileBytes() {
		if (!profileBytesPromise) {
			const bytes = Uint8Array.from(atob(DISPLAY_P3_PROFILE_BASE64), (character) => character.charCodeAt(0));
			profileBytesPromise = Promise.resolve(bytes);
		}
		return profileBytesPromise;
	}

	// PNG stores the profile zlib-compressed; CompressionStream's "deflate" is the zlib format.
	function getCompressedProfileBytes() {
		if (!compressedProfilePromise) {
			compressedProfilePromise = getProfileBytes().then(async (bytes) => {
				const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
				return new Uint8Array(await new Response(stream).arrayBuffer());
			});
		}
		return compressedProfilePromise;
	}

	function asciiBytes(text) {
		return new TextEncoder().encode(text);
	}

	function readFourCC(bytes, offset) {
		return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
	}

	const CRC_TABLE = (() => {
		const table = new Uint32Array(256);
		for (let index = 0; index < 256; index++) {
			let value = index;
			for (let bit = 0; bit < 8; bit++) {
				value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
			}
			table[index] = value >>> 0;
		}
		return table;
	})();

	function crc32(bytes) {
		let crc = 0xFFFFFFFF;
		for (let index = 0; index < bytes.length; index++) {
			crc = CRC_TABLE[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
		}
		return (crc ^ 0xFFFFFFFF) >>> 0;
	}

	/* ---------- PNG ---------- */

	function createPngChunk(type, data) {
		const typeAndData = new Uint8Array(4 + data.length);
		typeAndData.set(asciiBytes(type), 0);
		typeAndData.set(data, 4);

		const chunk = new Uint8Array(4 + typeAndData.length + 4);
		const view = new DataView(chunk.buffer);
		view.setUint32(0, data.length);
		chunk.set(typeAndData, 4);
		view.setUint32(4 + typeAndData.length, crc32(typeAndData));
		return chunk;
	}

	/*
	 * Inserts an iCCP chunk right after IHDR, as the PNG spec requires it before the
	 * image data. Any color chunks the encoder wrote are dropped, because a decoder
	 * may prefer sRGB or cICP over iCCP and silently ignore the profile.
	 */
	async function tagPng(blob) {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const view = new DataView(bytes.buffer);
		const compressedProfile = await getCompressedProfileBytes();

		const name = asciiBytes(PROFILE_DESCRIPTION);
		const iccpData = new Uint8Array(name.length + 2 + compressedProfile.length);
		iccpData.set(name, 0);
		iccpData[name.length] = 0;      // name terminator
		iccpData[name.length + 1] = 0;  // compression method: zlib
		iccpData.set(compressedProfile, name.length + 2);
		const iccpChunk = createPngChunk("iCCP", iccpData);

		const competingChunks = new Set(["iCCP", "sRGB", "gAMA", "cHRM", "cICP"]);
		const PNG_SIGNATURE_LENGTH = 8;
		const parts = [bytes.subarray(0, PNG_SIGNATURE_LENGTH)];

		let offset = PNG_SIGNATURE_LENGTH;
		while (offset + 8 <= bytes.length) {
			const dataLength = view.getUint32(offset);
			const type = readFourCC(bytes, offset + 4);
			const chunkEnd = offset + 12 + dataLength;
			if (!competingChunks.has(type)) {
				parts.push(bytes.subarray(offset, chunkEnd));
			}
			if (type === "IHDR") {
				parts.push(iccpChunk);
			}
			offset = chunkEnd;
		}
		return new Blob(parts, { type: "image/png" });
	}

	/* ---------- JPEG ---------- */

	function createJpegIccSegment(profile) {
		const signature = asciiBytes("ICC_PROFILE\0");
		// Length counts itself, the signature, the two sequence bytes and the profile.
		const segmentLength = 2 + signature.length + 2 + profile.length;
		const segment = new Uint8Array(2 + segmentLength);

		segment[0] = 0xFF;
		segment[1] = 0xE2;  // APP2
		segment[2] = segmentLength >> 8;
		segment[3] = segmentLength & 0xFF;
		segment.set(signature, 4);
		segment[4 + signature.length] = 1;  // chunk 1...
		segment[5 + signature.length] = 1;  // ...of 1
		segment.set(profile, 6 + signature.length);
		return segment;
	}

	/*
	 * Places the APP2 profile segment after the JFIF header (APP0), where readers
	 * expect it, replacing any profile the encoder may have written.
	 */
	async function tagJpeg(blob) {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const iccSegment = createJpegIccSegment(await getProfileBytes());

		const MARKER_APP0 = 0xE0;
		const MARKER_APP2 = 0xE2;
		const MARKER_START_OF_SCAN = 0xDA;

		const parts = [bytes.subarray(0, 2)];  // SOI
		let offset = 2;
		let inserted = false;

		while (offset + 4 <= bytes.length && bytes[offset] === 0xFF) {
			const marker = bytes[offset + 1];
			// Everything from the start of scan onward is entropy-coded image data.
			if (marker === MARKER_START_OF_SCAN) {
				break;
			}
			const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
			const segmentEnd = offset + 2 + segmentLength;
			const isExistingProfile = marker === MARKER_APP2
				&& segmentLength >= 14
				&& String.fromCharCode(...bytes.subarray(offset + 4, offset + 15)) === "ICC_PROFILE";

			if (!inserted && marker !== MARKER_APP0) {
				parts.push(iccSegment);
				inserted = true;
			}
			if (!isExistingProfile) {
				parts.push(bytes.subarray(offset, segmentEnd));
			}
			offset = segmentEnd;
		}

		if (!inserted) {
			parts.push(iccSegment);
		}
		parts.push(bytes.subarray(offset));
		return new Blob(parts, { type: "image/jpeg" });
	}

	/* ---------- WebP ---------- */

	function writeUint24LittleEndian(bytes, offset, value) {
		bytes[offset] = value & 0xFF;
		bytes[offset + 1] = (value >> 8) & 0xFF;
		bytes[offset + 2] = (value >> 16) & 0xFF;
	}

	function createVp8xChunk(width, height) {
		const chunk = new Uint8Array(18);
		chunk.set(asciiBytes("VP8X"), 0);
		new DataView(chunk.buffer).setUint32(4, 10, true);
		// Bytes 8-11 are flags and reserved bits, all zero; the canvas size is stored minus one.
		writeUint24LittleEndian(chunk, 12, width - 1);
		writeUint24LittleEndian(chunk, 15, height - 1);
		return chunk;
	}

	function createIccpChunk(profile) {
		const padding = profile.length & 1;  // RIFF chunks are padded to an even length
		const chunk = new Uint8Array(8 + profile.length + padding);
		chunk.set(asciiBytes("ICCP"), 0);
		new DataView(chunk.buffer).setUint32(4, profile.length, true);
		chunk.set(profile, 8);
		return chunk;
	}

	/*
	 * Simple WebP files (a bare VP8 or VP8L chunk) cannot carry metadata. The file is
	 * rewritten in the extended format: a VP8X header with the ICC flag set, then the
	 * ICCP chunk, then the original image chunks unchanged.
	 */
	async function tagWebp(blob, width, height) {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const view = new DataView(bytes.buffer);
		const profile = await getProfileBytes();

		if (readFourCC(bytes, 0) !== "RIFF" || readFourCC(bytes, 8) !== "WEBP") {
			return blob;
		}

		const chunks = [];
		let offset = 12;
		while (offset + 8 <= bytes.length) {
			const type = readFourCC(bytes, offset);
			const dataLength = view.getUint32(offset + 4, true);
			const chunkEnd = offset + 8 + dataLength + (dataLength & 1);
			chunks.push({ type, bytes: bytes.subarray(offset, chunkEnd) });
			offset = chunkEnd;
		}

		const existingHeader = chunks.find((chunk) => chunk.type === "VP8X");
		const header = existingHeader ? existingHeader.bytes.slice() : createVp8xChunk(width, height);
		const ICC_PROFILE_FLAG = 0x20;
		header[8] |= ICC_PROFILE_FLAG;

		const body = [header, createIccpChunk(profile)];
		for (const chunk of chunks) {
			if (chunk.type !== "VP8X" && chunk.type !== "ICCP") {
				body.push(chunk.bytes);
			}
		}

		const bodyLength = body.reduce((total, part) => total + part.length, 0);
		const riffHeader = new Uint8Array(12);
		riffHeader.set(asciiBytes("RIFF"), 0);
		new DataView(riffHeader.buffer).setUint32(4, 4 + bodyLength, true);
		riffHeader.set(asciiBytes("WEBP"), 8);
		return new Blob([riffHeader, ...body], { type: "image/webp" });
	}

	function tagWithDisplayP3(blob, format, width, height) {
		switch (format) {
			case "png": return tagPng(blob);
			case "jpeg": return tagJpeg(blob);
			case "webp": return tagWebp(blob, width, height);
			default: return Promise.resolve(blob);
		}
	}

	Blends.ColorProfile = {
		tagWithDisplayP3,
	};

})(window.Blends = window.Blends || {});
