"use strict";

/*
 * Mood presets and random palette generation. Colors are OKLCH objects:
 * { lightness: 0 to 1, chroma: roughly 0 to 0.32, hue: degrees }.
 */
(function (Blends) {

	/*
	 * A mood either pins its hues to a fixed range (hueRange) or picks a random
	 * base hue and spreads around it (hueSpread). Ranges may exceed 360 to wrap
	 * through red, as Dusk does.
	 */
	const MOODS = {
		mint:     { name: "Mint",           hueRange: [140, 205], lightnessRange: [0.30, 0.60], chromaRange: [0.04, 0.10] },
		dusk:     { name: "Dusk",           hueRange: [285, 425], lightnessRange: [0.28, 0.58], chromaRange: [0.06, 0.13] },
		ocean:    { name: "Ocean",          hueRange: [195, 265], lightnessRange: [0.22, 0.54], chromaRange: [0.05, 0.11] },
		ember:    { name: "Ember",          hueRange: [15, 75],   lightnessRange: [0.30, 0.60], chromaRange: [0.07, 0.14] },
		forest:   { name: "Forest",         hueRange: [95, 165],  lightnessRange: [0.22, 0.50], chromaRange: [0.04, 0.10] },
		night:    { name: "Night",          hueSpread: 80,        lightnessRange: [0.14, 0.30], chromaRange: [0.03, 0.07] },
		vivid:    { name: "Vivid",          hueSpread: 150,       lightnessRange: [0.40, 0.62], chromaRange: [0.15, 0.24] },
		pastel:   { name: "Pastel (light)", hueSpread: 140,       lightnessRange: [0.84, 0.93], chromaRange: [0.035, 0.075] },
		anything: { name: "Surprise me",    hueSpread: 100,       lightnessRange: [0.24, 0.62], chromaRange: [0.04, 0.13] },
	};

	const MAX_ACCENT_LIGHTNESS = 0.97;

	function lerp(from, to, amount) {
		return from + (to - from) * amount;
	}

	function shuffleInPlace(items) {
		for (let index = items.length - 1; index > 0; index--) {
			const swapIndex = Math.floor(Math.random() * (index + 1));
			[items[index], items[swapIndex]] = [items[swapIndex], items[index]];
		}
		return items;
	}

	/*
	 * Lightness values are stratified (one per evenly sized band, jittered within it)
	 * rather than drawn independently, so every palette has a real spread from dark
	 * to light instead of occasionally clumping into a flat, muddy field.
	 */
	function generatePalette(moodKey, colorCount, { withAccent = true } = {}) {
		const mood = MOODS[moodKey] || MOODS.anything;

		let hueStart;
		let hueEnd;
		if (mood.hueSpread) {
			const baseHue = Math.random() * 360;
			hueStart = baseHue - mood.hueSpread / 2;
			hueEnd = baseHue + mood.hueSpread / 2;
		} else {
			[hueStart, hueEnd] = mood.hueRange;
		}

		const lightnesses = [];
		for (let index = 0; index < colorCount; index++) {
			const band = (index + 0.2 + Math.random() * 0.6) / colorCount;
			lightnesses.push(lerp(mood.lightnessRange[0], mood.lightnessRange[1], band));
		}
		shuffleInPlace(lightnesses);

		const palette = [];
		for (let index = 0; index < colorCount; index++) {
			const hueBand = (index + Math.random() * 0.8) / colorCount;
			const hue = ((lerp(hueStart, hueEnd, hueBand) % 360) + 360) % 360;
			const chroma = lerp(mood.chromaRange[0], mood.chromaRange[1], Math.random());
			palette.push({
				lightness: Number(lightnesses[index].toFixed(3)),
				chroma: Number(chroma.toFixed(3)),
				hue: Math.round(hue),
			});
		}

		if (withAccent && colorCount > 0) {
			applyAccent(palette);
		}
		return palette;
	}

	/*
	 * One of the two lightest colors gets double the lightness. Picking from the
	 * lightest keeps the accent reading as a light source rather than a stray bright
	 * patch in an otherwise dark area; picking randomly between two keeps it from
	 * always landing on the same hue.
	 */
	function applyAccent(palette) {
		const indicesByLightness = palette
			.map((color, index) => index)
			.sort((first, second) => palette[second].lightness - palette[first].lightness);
		const candidates = indicesByLightness.slice(0, 2);
		const accent = palette[candidates[Math.floor(Math.random() * candidates.length)]];
		accent.lightness = Number(Math.min(MAX_ACCENT_LIGHTNESS, accent.lightness * 2).toFixed(3));
	}

	Blends.Palettes = {
		MOODS,
		generatePalette,
	};

})(window.Blends = window.Blends || {});
