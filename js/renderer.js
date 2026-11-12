"use strict";

/*
 * Renders a wallpaper into an RGBA pixel buffer.
 *
 * Coordinates are normalised so the shorter side of the image is 1. That keeps the
 * composition identical at every resolution, so the small preview and the full-size
 * export show the same picture.
 */
(function (Blends) {

	const { oklabToLinearSrgb, linearSrgbToLinearDisplayP3, fitChromaToGamut, oklchToOklab, encodeLinearTo8Bit } = Blends.Color;

	const TAU = Math.PI * 2;
	const MAX_BLOBS = 8;
	const BLOB_PLACEMENT_CANDIDATES = 14;
	const GRAIN_STRENGTH_IN_8BIT_STEPS = 9;

	// mulberry32: small, fast and good enough for layout decisions.
	function createSeededRandom(seed) {
		let state = seed >>> 0;
		return function nextRandom() {
			state = (state + 0x6D2B79F5) | 0;
			let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
			mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
		};
	}

	/*
	 * Best-candidate sampling: each blob takes the farthest of several random spots.
	 * Any prefix of the list is therefore well spread, so adding or removing a color
	 * keeps the existing layout instead of reshuffling everything.
	 * Blobs may sit slightly outside the frame so colors also flow in from the edges.
	 */
	function placeBlobs(random) {
		const blobs = [];
		for (let blobIndex = 0; blobIndex < MAX_BLOBS; blobIndex++) {
			let bestCandidate = null;
			let bestDistance = -1;
			for (let attempt = 0; attempt < BLOB_PLACEMENT_CANDIDATES; attempt++) {
				const x = -0.1 + random() * 1.2;
				const y = -0.1 + random() * 1.2;
				let nearestDistance = blobs.length ? Infinity : random();
				for (const blob of blobs) {
					nearestDistance = Math.min(nearestDistance, (blob.x - x) ** 2 + (blob.y - y) ** 2);
				}
				if (nearestDistance > bestDistance) {
					bestDistance = nearestDistance;
					bestCandidate = { x, y };
				}
			}
			bestCandidate.radius = 0.75 + random() * 0.5;
			blobs.push(bestCandidate);
		}
		return blobs;
	}

	/*
	 * Domain warp from a few low-frequency plane waves. It bends the boundaries
	 * between colors so they look organic instead of like overlapping circles.
	 */
	function createWarpWaves(random, warpAmount, frameScale) {
		const waves = [];
		for (let index = 0; index < 6; index++) {
			const angle = random() * TAU;
			const frequency = (0.5 + random() * 1.1) * TAU / frameScale;
			const amplitude = warpAmount * 0.16 * frameScale / (1 + (index % 3) * 0.7);
			waves.push({
				frequencyX: Math.cos(angle) * frequency,
				frequencyY: Math.sin(angle) * frequency,
				phase: random() * TAU,
				amplitude,
			});
		}
		return { horizontal: waves.slice(0, 3), vertical: waves.slice(3, 6) };
	}

	// A gentle lightness ramp in a random direction, so the image feels lit from one side.
	function createShading(random, shadingAmount, frameWidth, frameHeight) {
		const angle = random() * TAU;
		const directionX = Math.cos(angle);
		const directionY = Math.sin(angle);
		const halfExtent = (Math.abs(directionX) * frameWidth + Math.abs(directionY) * frameHeight) / 2;
		const strength = shadingAmount * 0.08;
		return {
			gradientX: directionX / halfExtent * strength,
			gradientY: directionY / halfExtent * strength,
		};
	}

	const VIGNETTE_FALLOFFS = {
		linear: (t) => t,
		smooth: (t) => t * t * (3 - 2 * t),
		smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
	};

	function buildScene(settings, width, height, colorSpace) {
		const frameWidth = width >= height ? width / height : 1;
		const frameHeight = width >= height ? 1 : height / width;
		const frameScale = (frameWidth + frameHeight) / 2;

		// The order of random draws defines the layout for a given seed; keep it stable.
		const random = createSeededRandom(settings.seed);
		const placements = placeBlobs(random);
		const warp = createWarpWaves(random, settings.warp, frameScale);
		const shading = createShading(random, settings.shading, frameWidth, frameHeight);

		const blobs = settings.palette.map((color, index) => {
			const placement = placements[index];
			const sigma = placement.radius * 0.3 * frameScale * settings.softness;
			const fittedChroma = fitChromaToGamut(color.lightness, color.chroma, color.hue, colorSpace);
			const lab = oklchToOklab(color.lightness, fittedChroma, color.hue);
			return {
				x: placement.x * frameWidth,
				y: placement.y * frameHeight,
				falloff: 1 / (2 * sigma * sigma),
				lightness: lab.lightness,
				a: lab.a,
				b: lab.b,
			};
		});

		return {
			width,
			height,
			frameWidth,
			frameHeight,
			centerX: frameWidth / 2,
			centerY: frameHeight / 2,
			blobs,
			warp,
			shading,
			colorSpace,
			seed: settings.seed | 0,
			grainAmount: settings.grain,
			vignetteStrength: Number(settings.vignetteStrength) || 0,
			vignetteCurve: VIGNETTE_FALLOFFS[settings.vignetteFalloff] || VIGNETTE_FALLOFFS.smoother,
		};
	}

	// lowbias32 by Chris Wellons: full avalanche, so neighbouring inputs give unrelated outputs.
	function hashMix(value) {
		value ^= value >>> 16;
		value = Math.imul(value, 0x7feb352d);
		value ^= value >>> 15;
		value = Math.imul(value, 0x846ca68b);
		value ^= value >>> 16;
		return value;
	}

	/*
	 * Film-like grain: three octaves of value noise at 1, 2 and 4 pixel cells.
	 * The finest octave alone looks like digital sensor noise; the coarser ones add
	 * the soft clumping of real grain. Each coarser lattice is rotated and offset so
	 * no axis-aligned grid pattern shows through. Grain is a pure function of the
	 * pixel position, so chunked exports match the preview exactly.
	 */
	function createGrainSampler(seed) {
		const octaveSalts = [hashMix(seed), hashMix(seed + 0x9E3779B9), hashMix(seed + 0x3C6EF372)];
		const octaveRotations = [0, 0.52, -0.87].map((angle) => ({ cos: Math.cos(angle), sin: Math.sin(angle) }));
		// Matches the standard deviation of the earlier single-octave grain, so slider values keep their meaning.
		const normalization = 1.2;

		function latticeValue(cellX, cellY, octave) {
			return (hashMix(cellX ^ hashMix(cellY ^ octaveSalts[octave])) >>> 0) / 4294967296 - 0.5;
		}

		function valueNoise(x, y, cellSize, octave) {
			const rotation = octaveRotations[octave];
			const latticeX = (x * rotation.cos - y * rotation.sin) / cellSize + octave * 17.3;
			const latticeY = (x * rotation.sin + y * rotation.cos) / cellSize + octave * 5.1;
			const cellX = Math.floor(latticeX);
			const cellY = Math.floor(latticeY);
			let blendX = latticeX - cellX;
			let blendY = latticeY - cellY;
			blendX = blendX * blendX * (3 - 2 * blendX);
			blendY = blendY * blendY * (3 - 2 * blendY);

			const topLeft = latticeValue(cellX, cellY, octave);
			const topRight = latticeValue(cellX + 1, cellY, octave);
			const bottomLeft = latticeValue(cellX, cellY + 1, octave);
			const bottomRight = latticeValue(cellX + 1, cellY + 1, octave);
			return topLeft
				+ (topRight - topLeft) * blendX
				+ (bottomLeft - topLeft) * blendY
				+ (topLeft - topRight - bottomLeft + bottomRight) * blendX * blendY;
		}

		return function sampleGrain(pixelX, pixelY) {
			return normalization * (
				latticeValue(pixelX, pixelY, 0)
				+ valueNoise(pixelX, pixelY, 2, 1)
				+ valueNoise(pixelX, pixelY, 4, 2)
			);
		};
	}

	/*
	 * Triangular-PDF dither of ±1 step, independent per pixel and channel. It has to be
	 * white noise: correlated noise would break up 8-bit quantisation steps less evenly.
	 * Each render chunk gets its own stream, seeded from its first row.
	 */
	function createDitherSource(seed, firstRow) {
		let state = (Math.imul(seed ^ 0x9E3779B9, 2654435761) ^ (firstRow * 0x85EBCA6B)) | 1;
		function nextUniform() {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 4294967296;
		}
		return function nextDither() {
			return nextUniform() - nextUniform();
		};
	}

	function sumWaves(waves, x, y) {
		let offset = 0;
		for (const wave of waves) {
			offset += wave.amplitude * Math.sin(wave.frequencyX * x + wave.frequencyY * y + wave.phase);
		}
		return offset;
	}

	/*
	 * Renders rows [firstRow, endRow) into an RGBA buffer. Splitting the image into
	 * row ranges lets large exports yield to the browser between chunks.
	 */
	function renderRows(scene, pixels, firstRow, endRow) {
		const { width, height, frameWidth, frameHeight, centerX, centerY, blobs, warp, shading } = scene;
		const blobCount = blobs.length;
		const exponents = new Float64Array(blobCount);
		const rgb = [0, 0, 0];
		const outputIsP3 = scene.colorSpace === "p3";

		const inverseCornerDistance = 1 / Math.hypot(frameWidth / 2, frameHeight / 2);
		const grainAmplitude = scene.grainAmount * GRAIN_STRENGTH_IN_8BIT_STEPS;
		const sampleGrain = createGrainSampler(scene.seed);
		const nextDither = createDitherSource(scene.seed, firstRow);

		for (let row = firstRow; row < endRow; row++) {
			const y = (row + 0.5) / height * frameHeight;
			let pixelOffset = row * width * 4;

			for (let column = 0; column < width; column++) {
				const x = (column + 0.5) / width * frameWidth;
				const warpedX = x + sumWaves(warp.horizontal, x, y);
				const warpedY = y + sumWaves(warp.vertical, x, y);

				/*
				 * Each pixel is a weighted average of all blob colors in OKLab, weighted
				 * by a Gaussian of the distance to each blob. Averaging in a perceptual
				 * space avoids the grey, muddy midpoints of mixing in RGB. Normalising
				 * by the largest exponent first keeps exp() from underflowing to zero
				 * far from every blob.
				 */
				let largestExponent = -Infinity;
				for (let index = 0; index < blobCount; index++) {
					const blob = blobs[index];
					const deltaX = warpedX - blob.x;
					const deltaY = warpedY - blob.y;
					const exponent = -(deltaX * deltaX + deltaY * deltaY) * blob.falloff;
					exponents[index] = exponent;
					if (exponent > largestExponent) {
						largestExponent = exponent;
					}
				}

				let weightSum = 0;
				let lightness = 0;
				let a = 0;
				let b = 0;
				for (let index = 0; index < blobCount; index++) {
					const blob = blobs[index];
					const weight = Math.exp(exponents[index] - largestExponent);
					weightSum += weight;
					lightness += weight * blob.lightness;
					a += weight * blob.a;
					b += weight * blob.b;
				}

				const shadedLightness = lightness / weightSum
					+ (x - centerX) * shading.gradientX
					+ (y - centerY) * shading.gradientY;
				oklabToLinearSrgb(shadedLightness, a / weightSum, b / weightSum, rgb);
				if (outputIsP3) {
					linearSrgbToLinearDisplayP3(rgb);
				}

				// Applied in linear light, like real lens falloff, so hues hold steady toward the edges.
				if (scene.vignetteStrength > 0) {
					const distanceToCorner = Math.hypot(x - centerX, y - centerY) * inverseCornerDistance;
					const multiplier = 1 - scene.vignetteStrength * scene.vignetteCurve(distanceToCorner);
					rgb[0] *= multiplier;
					rgb[1] *= multiplier;
					rgb[2] *= multiplier;
				}

				// Grain is shared by all channels so it reads as luminance texture, not color speckle.
				const grain = grainAmplitude ? sampleGrain(column, row) * grainAmplitude : 0;
				for (let channel = 0; channel < 3; channel++) {
					// Uint8ClampedArray rounds and clamps on assignment.
					pixels[pixelOffset + channel] = encodeLinearTo8Bit(rgb[channel]) + grain + nextDither();
				}
				pixels[pixelOffset + 3] = 255;
				pixelOffset += 4;
			}
		}
	}

	Blends.Renderer = {
		buildScene,
		renderRows,
	};

})(window.Blends = window.Blends || {});
