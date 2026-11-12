"use strict";

/*
 * Color math: OKLab to linear RGB, gamut fitting and the sRGB transfer curve.
 *
 * Display P3 uses the same D65 white point and the same transfer curve as sRGB,
 * so supporting it only takes one extra matrix in linear light.
 */
(function (Blends) {

	const DEGREES_TO_RADIANS = Math.PI / 180;

	// Björn Ottosson's OKLab -> LMS -> linear sRGB matrices.
	function oklabToLinearSrgb(lightness, a, b, out) {
		let l = lightness + 0.3963377774 * a + 0.2158037573 * b;
		let m = lightness - 0.1055613458 * a - 0.0638541728 * b;
		let s = lightness - 0.0894841775 * a - 1.2914855480 * b;

		l = l * l * l;
		m = m * m * m;
		s = s * s * s;

		out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
		out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
		out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
		return out;
	}

	function linearSrgbToLinearDisplayP3(rgb) {
		const red = rgb[0];
		const green = rgb[1];
		const blue = rgb[2];

		rgb[0] = 0.8224621 * red + 0.1775380 * green;
		rgb[1] = 0.0331941 * red + 0.9668058 * green;
		rgb[2] = 0.0170827 * red + 0.0723974 * green + 0.9105199 * blue;
		return rgb;
	}

	function oklabToLinear(lightness, a, b, colorSpace, out) {
		oklabToLinearSrgb(lightness, a, b, out);
		if (colorSpace === "p3") {
			linearSrgbToLinearDisplayP3(out);
		}
		return out;
	}

	function oklchToOklab(lightness, chroma, hueDegrees) {
		const hue = hueDegrees * DEGREES_TO_RADIANS;
		return {
			lightness: lightness,
			a: chroma * Math.cos(hue),
			b: chroma * Math.sin(hue),
		};
	}

	function isInGamut(rgb) {
		const tolerance = 1e-4;
		return rgb[0] >= -tolerance && rgb[0] <= 1 + tolerance
			&& rgb[1] >= -tolerance && rgb[1] <= 1 + tolerance
			&& rgb[2] >= -tolerance && rgb[2] <= 1 + tolerance;
	}

	/*
	 * Returns the largest chroma, up to the requested one, that fits the target gamut.
	 * Lightness and hue are held fixed so an out-of-gamut color stays recognisably
	 * itself and only gets less saturated. The gamut boundary has no closed form
	 * in OKLCH, hence the bisection.
	 */
	function fitChromaToGamut(lightness, chroma, hueDegrees, colorSpace) {
		const hue = hueDegrees * DEGREES_TO_RADIANS;
		const cosHue = Math.cos(hue);
		const sinHue = Math.sin(hue);
		const rgb = [0, 0, 0];
		const clampedLightness = Math.min(1, Math.max(0, lightness));

		const fits = (candidateChroma) => isInGamut(oklabToLinear(
			clampedLightness,
			candidateChroma * cosHue,
			candidateChroma * sinHue,
			colorSpace,
			rgb
		));

		if (fits(chroma)) {
			return chroma;
		}

		let low = 0;
		let high = chroma;
		for (let iteration = 0; iteration < 16; iteration++) {
			const middle = (low + high) / 2;
			if (fits(middle)) {
				low = middle;
			} else {
				high = middle;
			}
		}
		return low;
	}

	/*
	 * The sRGB transfer curve, tabulated. Calling Math.pow three times per pixel is the
	 * single most expensive thing in the render loop otherwise, and with linear
	 * interpolation between 4096 entries the error stays far below one 8-bit step.
	 */
	const ENCODE_TABLE_SIZE = 4096;
	const encodeTable = buildEncodeTable();

	function buildEncodeTable() {
		const table = new Float32Array(ENCODE_TABLE_SIZE + 2);
		for (let index = 0; index < table.length; index++) {
			const linear = Math.min(1, index / ENCODE_TABLE_SIZE);
			const encoded = linear <= 0.0031308
				? 12.92 * linear
				: 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
			table[index] = encoded * 255;
		}
		return table;
	}

	// Returns the encoded value in 8-bit units, still unrounded so dither can be added.
	function encodeLinearTo8Bit(linear) {
		if (linear <= 0) {
			return 0;
		}
		if (linear >= 1) {
			return 255;
		}
		const position = linear * ENCODE_TABLE_SIZE;
		const index = position | 0;
		const fraction = position - index;
		return encodeTable[index] + (encodeTable[index + 1] - encodeTable[index]) * fraction;
	}

	Blends.Color = {
		oklabToLinearSrgb,
		linearSrgbToLinearDisplayP3,
		oklabToLinear,
		oklchToOklab,
		fitChromaToGamut,
		encodeLinearTo8Bit,
	};

})(window.Blends = window.Blends || {});
