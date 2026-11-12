"use strict";

/*
 * User interface: settings, live preview, palette editor and file export.
 */
(function (Blends) {

	const { MOODS, generatePalette } = Blends.Palettes;
	const { buildScene, renderRows } = Blends.Renderer;
	const { fitChromaToGamut } = Blends.Color;
	const { tagWithDisplayP3 } = Blends.ColorProfile;

	const STORAGE_KEY = "blends-settings";
	const MIN_PALETTE_SIZE = 2;
	const MAX_PALETTE_SIZE = 7;
	const MAX_CUSTOM_DIMENSION = 8192;
	const MIN_CUSTOM_DIMENSION = 64;
	// Mobile Safari refuses larger canvases; staying below it keeps exports working everywhere.
	const MAX_EXPORT_PIXELS = 16777216;
	const MAX_PREVIEW_PIXELS = 2.4e6;
	const DRAFT_PREVIEW_DIVISOR = 4;
	const FULL_PREVIEW_DELAY_MS = 180;
	const EXPORT_PIXELS_PER_CHUNK = 160000;
	const VIGNETTE_SLIDER_MAX_STOPS = 7;
	const VIGNETTE_FALLOFF_TYPES = ["linear", "smooth", "smoother"];
	const COLOR_EDITOR_MAX_CHROMA = 0.32;

	const element = (id) => document.getElementById(id);

	/* ---------- Environment ---------- */

	const previewPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
	const screenWidth = Math.round((screen.width || 1920) * (window.devicePixelRatio || 1));
	const screenHeight = Math.round((screen.height || 1080) * (window.devicePixelRatio || 1));

	const OUTPUT_SIZES = [
		{ key: "screen", label: `This screen (${screenWidth} × ${screenHeight})`, width: screenWidth, height: screenHeight },
		{ key: "fhd", label: "1920 × 1080", width: 1920, height: 1080 },
		{ key: "qhd", label: "2560 × 1440", width: 2560, height: 1440 },
		{ key: "wqxga", label: "2560 × 1600", width: 2560, height: 1600 },
		{ key: "ultrawide", label: "3440 × 1440 ultrawide", width: 3440, height: 1440 },
		{ key: "uhd", label: "3840 × 2160 (4K)", width: 3840, height: 2160 },
		{ key: "5k", label: "5120 × 2880 (5K)", width: 5120, height: 2880 },
		{ key: "phone", label: "1290 × 2796 phone", width: 1290, height: 2796 },
		{ key: "custom", label: "Custom size", width: 0, height: 0 },
	];

	function detectP3CanvasSupport() {
		try {
			const context = document.createElement("canvas").getContext("2d", { colorSpace: "display-p3" });
			return Boolean(context && context.getContextAttributes
				&& context.getContextAttributes().colorSpace === "display-p3");
		} catch (error) {
			return false;
		}
	}

	// Browsers silently fall back to PNG for formats they cannot encode, so probe each one.
	function canEncode(mimeType) {
		try {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			return canvas.toDataURL(mimeType).startsWith("data:" + mimeType);
		} catch (error) {
			return false;
		}
	}

	const supportsP3Canvas = detectP3CanvasSupport();
	const displayIsWideGamut = Boolean(window.matchMedia && window.matchMedia("(color-gamut: p3)").matches);

	const FILE_FORMATS = {
		png: { label: "PNG", mimeType: "image/png", extension: "png", supported: true },
		jpeg: { label: "JPEG", mimeType: "image/jpeg", extension: "jpg", supported: canEncode("image/jpeg") },
		webp: { label: "WebP", mimeType: "image/webp", extension: "webp", supported: canEncode("image/webp") },
	};

	/* ---------- Settings ---------- */

	function randomSeed() {
		return (Math.random() * 2 ** 32) >>> 0;
	}

	function createDefaultSettings() {
		return {
			seed: randomSeed(),
			mood: "mint",
			palette: generatePalette("mint", 5),
			softness: 1.0,
			warp: 0.4,
			shading: 0.5,
			vignetteStrength: 0.95,
			vignetteFalloff: "smoother",
			grain: 0.5,
			outputSize: "screen",
			customWidth: 2560,
			customHeight: 1440,
			colorSpace: "srgb",
			fileFormat: "png",
			quality: 0.95,
		};
	}

	function loadSettings() {
		const settings = createDefaultSettings();
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
			if (saved && Array.isArray(saved.palette) && saved.palette.length >= MIN_PALETTE_SIZE) {
				Object.assign(settings, saved);
			}
		} catch (error) {
			// Storage can be unavailable (private mode, some file:// setups); defaults are fine.
		}

		if (!MOODS[settings.mood] && settings.mood !== "custom") {
			settings.mood = "mint";
		}
		if (settings.colorSpace === "p3" && !supportsP3Canvas) {
			settings.colorSpace = "srgb";
		}
		if (!FILE_FORMATS[settings.fileFormat] || !FILE_FORMATS[settings.fileFormat].supported) {
			settings.fileFormat = "png";
		}
		if (!VIGNETTE_FALLOFF_TYPES.includes(settings.vignetteFalloff)) {
			settings.vignetteFalloff = "smoother";
		}
		return settings;
	}

	function saveSettings() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch (error) {
			// Persisting is a convenience only.
		}
	}

	const settings = loadSettings();
	let selectedColorIndex = -1;

	function getOutputSize() {
		if (settings.outputSize === "custom") {
			const clampDimension = (value) => Math.max(MIN_CUSTOM_DIMENSION,
				Math.min(MAX_CUSTOM_DIMENSION, Math.round(Number(value) || 0)));
			return {
				width: clampDimension(settings.customWidth),
				height: clampDimension(settings.customHeight),
			};
		}
		const size = OUTPUT_SIZES.find((candidate) => candidate.key === settings.outputSize) || OUTPUT_SIZES[0];
		return { width: size.width, height: size.height };
	}

	// Mood used when generating new colors; edited palettes fall back to "anything".
	function activeMoodKey() {
		return MOODS[settings.mood] ? settings.mood : "anything";
	}

	/* ---------- Canvas helpers ---------- */

	function canvasContextOptions(colorSpace) {
		return colorSpace === "p3" ? { colorSpace: "display-p3" } : {};
	}

	function createImageData(context, width, height, colorSpace) {
		try {
			return context.createImageData(width, height, {
				colorSpace: colorSpace === "p3" ? "display-p3" : "srgb",
			});
		} catch (error) {
			return context.createImageData(width, height);
		}
	}

	/* ---------- Preview ---------- */

	const stage = element("stage");
	const previewFrame = element("preview-frame");
	const draftCanvas = document.createElement("canvas");

	let previewCanvas = null;
	let previewContext = null;
	let previewCanvasColorSpace = null;
	let previewWidth = 0;
	let previewHeight = 0;

	// A canvas's color space is fixed at creation, so switching spaces needs a new canvas.
	function ensurePreviewCanvas() {
		if (previewCanvas && previewCanvasColorSpace === settings.colorSpace) {
			return;
		}
		previewCanvas = document.createElement("canvas");
		previewContext = previewCanvas.getContext("2d", canvasContextOptions(settings.colorSpace));
		previewCanvasColorSpace = settings.colorSpace;
		previewFrame.replaceChildren(previewCanvas);
	}

	function resizePreviewCanvas() {
		if (previewCanvas.width !== previewWidth || previewCanvas.height !== previewHeight) {
			previewCanvas.width = previewWidth;
			previewCanvas.height = previewHeight;
		}
	}

	// Fits the frame to the stage with the output's aspect ratio.
	function layoutPreviewFrame() {
		const { width, height } = getOutputSize();
		const stageStyle = getComputedStyle(stage);
		const horizontalPadding = parseFloat(stageStyle.paddingLeft) + parseFloat(stageStyle.paddingRight);
		const verticalPadding = parseFloat(stageStyle.paddingTop) + parseFloat(stageStyle.paddingBottom);
		const captionHeight = stage.querySelector(".caption").offsetHeight + 14;

		const availableWidth = Math.max(80, stage.clientWidth - horizontalPadding);
		const availableHeight = Math.max(80, stage.clientHeight - verticalPadding - captionHeight);
		const scale = Math.min(availableWidth / width, availableHeight / height);
		const frameWidth = Math.max(1, Math.floor(width * scale));
		const frameHeight = Math.max(1, Math.floor(height * scale));

		previewFrame.style.width = frameWidth + "px";
		previewFrame.style.height = frameHeight + "px";

		let pixelWidth = Math.round(frameWidth * previewPixelRatio);
		let pixelHeight = Math.round(frameHeight * previewPixelRatio);
		const pixelArea = pixelWidth * pixelHeight;
		if (pixelArea > MAX_PREVIEW_PIXELS) {
			const reduction = Math.sqrt(MAX_PREVIEW_PIXELS / pixelArea);
			pixelWidth = Math.round(pixelWidth * reduction);
			pixelHeight = Math.round(pixelHeight * reduction);
		}
		previewWidth = pixelWidth;
		previewHeight = pixelHeight;
	}

	/*
	 * While a slider is moving, a quarter-resolution draft is rendered and scaled up.
	 * The image is smooth enough that the draft looks right, and it keeps dragging
	 * fluid. Grain is skipped because upscaling would turn it into blotches.
	 */
	function drawDraftPreview() {
		ensurePreviewCanvas();
		const draftWidth = Math.max(16, Math.round(previewWidth / DRAFT_PREVIEW_DIVISOR));
		const draftHeight = Math.max(16, Math.round(previewHeight / DRAFT_PREVIEW_DIVISOR));
		draftCanvas.width = draftWidth;
		draftCanvas.height = draftHeight;

		let draftContext;
		try {
			draftContext = draftCanvas.getContext("2d", canvasContextOptions(settings.colorSpace));
		} catch (error) {
			draftContext = draftCanvas.getContext("2d");
		}

		const imageData = createImageData(draftContext, draftWidth, draftHeight, settings.colorSpace);
		const scene = buildScene({ ...settings, grain: 0 }, draftWidth, draftHeight, settings.colorSpace);
		renderRows(scene, imageData.data, 0, draftHeight);
		draftContext.putImageData(imageData, 0, 0);

		resizePreviewCanvas();
		previewContext.imageSmoothingEnabled = true;
		previewContext.imageSmoothingQuality = "high";
		previewContext.drawImage(draftCanvas, 0, 0, previewWidth, previewHeight);
	}

	function drawFullPreview() {
		ensurePreviewCanvas();
		resizePreviewCanvas();
		const imageData = createImageData(previewContext, previewWidth, previewHeight, settings.colorSpace);
		const scene = buildScene(settings, previewWidth, previewHeight, settings.colorSpace);
		renderRows(scene, imageData.data, 0, previewHeight);
		previewContext.putImageData(imageData, 0, 0);
	}

	let draftFrameRequested = false;
	let fullPreviewTimer = 0;

	function requestPreview() {
		if (!draftFrameRequested) {
			draftFrameRequested = true;
			requestAnimationFrame(() => {
				draftFrameRequested = false;
				drawDraftPreview();
			});
		}
		clearTimeout(fullPreviewTimer);
		fullPreviewTimer = setTimeout(drawFullPreview, FULL_PREVIEW_DELAY_MS);
		saveSettings();
	}

	/* ---------- Palette and editor ---------- */

	function cssColor(color) {
		const fittedChroma = fitChromaToGamut(color.lightness, color.chroma, color.hue, settings.colorSpace);
		return `oklch(${color.lightness} ${fittedChroma.toFixed(4)} ${color.hue})`;
	}

	// The interface picks up the palette's average hue so it sits in the same mood as the image.
	function updateInterfaceTint() {
		let sumA = 0;
		let sumB = 0;
		for (const color of settings.palette) {
			const hue = color.hue * Math.PI / 180;
			sumA += color.chroma * Math.cos(hue);
			sumB += color.chroma * Math.sin(hue);
		}
		const meanA = sumA / settings.palette.length;
		const meanB = sumB / settings.palette.length;
		const chroma = Math.hypot(meanA, meanB);
		const hue = (Math.atan2(meanB, meanA) * 180 / Math.PI + 360) % 360;

		const rootStyle = document.documentElement.style;
		rootStyle.setProperty("--tint-hue", hue.toFixed(1));
		rootStyle.setProperty("--tint-chroma", Math.min(chroma, 0.08).toFixed(4));
	}

	function renderSwatches() {
		const container = element("swatches");
		container.replaceChildren();

		settings.palette.forEach((color, index) => {
			const swatch = document.createElement("button");
			swatch.type = "button";
			swatch.className = "swatch";
			swatch.style.background = cssColor(color);
			swatch.setAttribute("aria-label", `Edit color ${index + 1}`);
			swatch.setAttribute("aria-pressed", String(index === selectedColorIndex));
			swatch.addEventListener("click", () => {
				selectedColorIndex = selectedColorIndex === index ? -1 : index;
				syncColorEditor();
				renderSwatches();
			});
			container.appendChild(swatch);
		});

		const addButton = document.createElement("button");
		addButton.type = "button";
		addButton.className = "swatch add";
		addButton.textContent = "+";
		addButton.setAttribute("aria-label", "Add a color");
		addButton.disabled = settings.palette.length >= MAX_PALETTE_SIZE;
		addButton.addEventListener("click", addColor);
		container.appendChild(addButton);
	}

	// The new color comes from a fresh palette of the current mood, without an accent, so there is still only one.
	function addColor() {
		const freshPalette = generatePalette(activeMoodKey(), settings.palette.length + 1, { withAccent: false });
		settings.palette.push(freshPalette[freshPalette.length - 1]);
		selectedColorIndex = settings.palette.length - 1;
		onPaletteChanged();
	}

	// Slider tracks show the color each position would produce, clipped to the current gamut.
	function updateEditorTracks(color) {
		const { lightness, chroma, hue } = color;
		const colorSpace = settings.colorSpace;
		const stop = (stopLightness, stopChroma, stopHue) =>
			`oklch(${stopLightness.toFixed(2)} ${fitChromaToGamut(stopLightness, stopChroma, stopHue, colorSpace).toFixed(3)} ${stopHue})`;

		const lightnessStops = [];
		for (let step = 0; step <= 10; step++) {
			lightnessStops.push(stop(step / 10, chroma, hue));
		}
		const chromaStops = [];
		for (let step = 0; step <= 8; step++) {
			chromaStops.push(stop(lightness, COLOR_EDITOR_MAX_CHROMA * step / 8, hue));
		}
		const hueStops = [];
		for (let stepHue = 0; stepHue <= 360; stepHue += 30) {
			hueStops.push(stop(lightness, chroma, stepHue));
		}

		element("lightness-slider").style.setProperty("--track", `linear-gradient(90deg, ${lightnessStops.join(", ")})`);
		element("chroma-slider").style.setProperty("--track", `linear-gradient(90deg, ${chromaStops.join(", ")})`);
		element("hue-slider").style.setProperty("--track", `linear-gradient(90deg, ${hueStops.join(", ")})`);
	}

	function describeGamut(color) {
		const tolerance = 1e-4;
		const fittedChroma = fitChromaToGamut(color.lightness, color.chroma, color.hue, settings.colorSpace);
		const fitsSrgb = fitChromaToGamut(color.lightness, color.chroma, color.hue, "srgb") >= color.chroma - tolerance;

		if (fittedChroma < color.chroma - tolerance) {
			const spaceName = settings.colorSpace === "p3" ? "Display P3" : "sRGB";
			return `Outside ${spaceName}, so chroma is reduced to ${fittedChroma.toFixed(3)} at this lightness and hue.`;
		}
		if (!fitsSrgb) {
			return "Outside sRGB: this color only exists in the Display P3 export.";
		}
		return "";
	}

	function syncColorEditor() {
		const editor = element("color-editor");
		const color = settings.palette[selectedColorIndex];
		if (!color) {
			editor.hidden = true;
			return;
		}
		editor.hidden = false;

		element("lightness-slider").value = color.lightness;
		element("chroma-slider").value = color.chroma;
		element("hue-slider").value = color.hue;
		element("lightness-value").textContent = Math.round(color.lightness * 100) + "%";
		element("chroma-value").textContent = color.chroma.toFixed(3);
		element("hue-value").textContent = color.hue + "°";
		updateEditorTracks(color);

		const gamutNote = describeGamut(color);
		element("gamut-note").textContent = gamutNote;
		element("gamut-note").hidden = !gamutNote;
		element("remove-color-button").disabled = settings.palette.length <= MIN_PALETTE_SIZE;
	}

	function editSelectedColor(property, value) {
		const color = settings.palette[selectedColorIndex];
		if (!color) {
			return;
		}
		color[property] = value;
		if (settings.mood !== "custom") {
			settings.mood = "custom";
			element("mood-select").value = "custom";
		}
		updateInterfaceTint();
		syncColorEditor();
		// Only this swatch changes, and re-rendering all of them would interrupt the drag.
		const swatch = element("swatches").children[selectedColorIndex];
		if (swatch) {
			swatch.style.background = cssColor(color);
		}
		requestPreview();
	}

	function onPaletteChanged() {
		updateInterfaceTint();
		renderSwatches();
		syncColorEditor();
		requestPreview();
	}

	/* ---------- Controls ---------- */

	const formatPercent = (value) => Math.round(value * 100) + "%";

	const PLAIN_SLIDERS = [
		{ setting: "softness", sliderId: "softness-slider", valueId: "softness-value", format: (value) => value.toFixed(2) },
		{ setting: "warp", sliderId: "warp-slider", valueId: "warp-value", format: formatPercent },
		{ setting: "shading", sliderId: "shading-slider", valueId: "shading-value", format: formatPercent },
		{ setting: "grain", sliderId: "grain-slider", valueId: "grain-value", format: formatPercent },
	];

	/*
	 * The vignette strength slider is linear in photographic stops of corner darkening
	 * rather than in strength. Useful values cluster near 100%, where a linear slider
	 * would cram them into its last few pixels. The far end snaps to exactly 100%.
	 */
	function vignetteSliderToStrength(position) {
		return position >= 1 ? 1 : 1 - Math.pow(2, -VIGNETTE_SLIDER_MAX_STOPS * position);
	}

	function vignetteStrengthToSlider(strength) {
		return strength >= 1 ? 1 : -Math.log2(1 - strength) / VIGNETTE_SLIDER_MAX_STOPS;
	}

	function formatVignetteStrength(strength) {
		if (strength >= 1) {
			return "100%";
		}
		return strength >= 0.9 ? (strength * 100).toFixed(1) + "%" : formatPercent(strength);
	}

	function setPressed(id, pressed) {
		element(id).setAttribute("aria-pressed", String(pressed));
	}

	function colorSpaceHint() {
		if (!supportsP3Canvas) {
			return "This browser can’t write Display P3 images, so exports are sRGB.";
		}
		if (settings.colorSpace === "srgb") {
			return "Works everywhere. Pick Display P3 for wide-gamut screens.";
		}
		return displayIsWideGamut
			? "Wider gamut, tagged with a Display P3 profile. Most noticeable with the Vivid mood."
			: "Exports are tagged Display P3, but this display shows sRGB, so the preview won’t show the extra range.";
	}

	function fileFormatHint() {
		let hint;
		if (settings.fileFormat === "png") {
			hint = "Lossless, with the largest files.";
		} else if (settings.fileFormat === "webp" && settings.quality >= 1) {
			hint = "At 100%, Chromium-based browsers write lossless WebP: identical to the PNG at roughly half the size.";
		} else {
			hint = "Much smaller files, but compression smooths away some of the dither, so very dark gradients can show faint steps. Higher quality keeps more of it.";
		}
		if (!FILE_FORMATS.webp.supported) {
			hint += " This browser can’t encode WebP.";
		}
		return hint;
	}

	function syncControls() {
		element("mood-select").value = MOODS[settings.mood] ? settings.mood : "custom";

		for (const slider of PLAIN_SLIDERS) {
			element(slider.sliderId).value = settings[slider.setting];
			element(slider.valueId).textContent = slider.format(Number(settings[slider.setting]));
		}

		element("vignette-strength-slider").value = vignetteStrengthToSlider(settings.vignetteStrength);
		element("vignette-strength-value").textContent = formatVignetteStrength(settings.vignetteStrength);
		for (const falloff of VIGNETTE_FALLOFF_TYPES) {
			setPressed("vignette-falloff-" + falloff, settings.vignetteFalloff === falloff);
		}

		element("size-select").value = settings.outputSize;
		element("custom-size").hidden = settings.outputSize !== "custom";
		element("custom-width").value = settings.customWidth;
		element("custom-height").value = settings.customHeight;

		setPressed("color-space-srgb", settings.colorSpace === "srgb");
		setPressed("color-space-p3", settings.colorSpace === "p3");
		element("color-space-p3").disabled = !supportsP3Canvas;
		element("color-space-hint").textContent = colorSpaceHint();

		for (const [formatKey, format] of Object.entries(FILE_FORMATS)) {
			setPressed("format-" + formatKey, settings.fileFormat === formatKey);
			element("format-" + formatKey).disabled = !format.supported;
		}
		element("quality-field").hidden = settings.fileFormat === "png";
		element("quality-slider").value = settings.quality;
		element("quality-value").textContent = formatPercent(settings.quality);
		element("format-hint").textContent = fileFormatHint();
		element("save-button").textContent = "Save " + FILE_FORMATS[settings.fileFormat].label;

		const { width, height } = getOutputSize();
		const spaceName = settings.colorSpace === "p3" ? "Display P3" : "sRGB";
		element("output-description").textContent = `${width} × ${height} px, ${spaceName}`;
	}

	function generateNewColors() {
		if (!MOODS[settings.mood]) {
			settings.mood = "anything";
			syncControls();
		}
		settings.palette = generatePalette(settings.mood, settings.palette.length);
		onPaletteChanged();
	}

	function generateNewLayout() {
		settings.seed = randomSeed();
		requestPreview();
	}

	function generateNewWallpaper() {
		const moodKeys = Object.keys(MOODS).filter((key) => key !== "anything");
		settings.mood = moodKeys[Math.floor(Math.random() * moodKeys.length)];
		settings.palette = generatePalette(settings.mood, 4 + Math.floor(Math.random() * 2));
		settings.seed = randomSeed();
		selectedColorIndex = -1;
		syncControls();
		onPaletteChanged();
	}

	function setColorSpace(colorSpace) {
		if (colorSpace === settings.colorSpace || (colorSpace === "p3" && !supportsP3Canvas)) {
			return;
		}
		settings.colorSpace = colorSpace;
		syncControls();
		syncColorEditor();
		renderSwatches();
		requestPreview();
	}

	function onOutputSizeChanged() {
		syncControls();
		layoutPreviewFrame();
		requestPreview();
	}

	function populateSelects() {
		const moodSelect = element("mood-select");
		for (const [key, mood] of Object.entries(MOODS)) {
			moodSelect.add(new Option(mood.name, key));
		}
		moodSelect.add(new Option("Custom", "custom"));

		const sizeSelect = element("size-select");
		for (const size of OUTPUT_SIZES) {
			sizeSelect.add(new Option(size.label, size.key));
		}
	}

	function bindControls() {
		element("new-wallpaper-button").addEventListener("click", generateNewWallpaper);
		element("new-colors-button").addEventListener("click", generateNewColors);
		element("new-layout-button").addEventListener("click", generateNewLayout);

		element("mood-select").addEventListener("change", (event) => {
			const mood = event.target.value;
			settings.mood = mood;
			if (mood === "custom") {
				return;
			}
			settings.palette = generatePalette(mood, settings.palette.length);
			selectedColorIndex = -1;
			onPaletteChanged();
		});

		element("lightness-slider").addEventListener("input", (event) => editSelectedColor("lightness", Number(event.target.value)));
		element("chroma-slider").addEventListener("input", (event) => editSelectedColor("chroma", Number(event.target.value)));
		element("hue-slider").addEventListener("input", (event) => editSelectedColor("hue", Math.round(Number(event.target.value))));
		element("remove-color-button").addEventListener("click", () => {
			if (selectedColorIndex < 0 || settings.palette.length <= MIN_PALETTE_SIZE) {
				return;
			}
			settings.palette.splice(selectedColorIndex, 1);
			selectedColorIndex = -1;
			onPaletteChanged();
		});
		element("close-editor-button").addEventListener("click", () => {
			selectedColorIndex = -1;
			renderSwatches();
			syncColorEditor();
		});

		for (const slider of PLAIN_SLIDERS) {
			element(slider.sliderId).addEventListener("input", (event) => {
				settings[slider.setting] = Number(event.target.value);
				element(slider.valueId).textContent = slider.format(settings[slider.setting]);
				requestPreview();
			});
		}

		element("vignette-strength-slider").addEventListener("input", (event) => {
			settings.vignetteStrength = Number(vignetteSliderToStrength(Number(event.target.value)).toFixed(5));
			element("vignette-strength-value").textContent = formatVignetteStrength(settings.vignetteStrength);
			requestPreview();
		});
		for (const falloff of VIGNETTE_FALLOFF_TYPES) {
			element("vignette-falloff-" + falloff).addEventListener("click", () => {
				settings.vignetteFalloff = falloff;
				syncControls();
				requestPreview();
			});
		}

		element("size-select").addEventListener("change", (event) => {
			settings.outputSize = event.target.value;
			onOutputSizeChanged();
		});
		element("custom-width").addEventListener("change", (event) => {
			settings.customWidth = Number(event.target.value);
			onOutputSizeChanged();
		});
		element("custom-height").addEventListener("change", (event) => {
			settings.customHeight = Number(event.target.value);
			onOutputSizeChanged();
		});

		element("color-space-srgb").addEventListener("click", () => setColorSpace("srgb"));
		element("color-space-p3").addEventListener("click", () => setColorSpace("p3"));

		for (const [formatKey, format] of Object.entries(FILE_FORMATS)) {
			element("format-" + formatKey).addEventListener("click", () => {
				if (!format.supported) {
					return;
				}
				settings.fileFormat = formatKey;
				syncControls();
				saveSettings();
			});
		}
		element("quality-slider").addEventListener("input", (event) => {
			settings.quality = Number(event.target.value);
			syncControls();
			saveSettings();
		});

		element("save-button").addEventListener("click", exportWallpaper);

		document.addEventListener("keydown", (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			const target = event.target;
			const isTyping = target && ((target.tagName === "INPUT" && target.type !== "range")
				|| target.tagName === "SELECT" || target.isContentEditable);
			if (isTyping) {
				return;
			}
			const key = event.key.toLowerCase();
			if (key === "n") {
				event.preventDefault();
				generateNewWallpaper();
			} else if (key === "l") {
				event.preventDefault();
				generateNewLayout();
			}
		});

		new ResizeObserver(() => {
			layoutPreviewFrame();
			requestPreview();
		}).observe(stage);
	}

	/* ---------- Export ---------- */

	function yieldToBrowser() {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	function canvasToBlob(canvas, mimeType, quality) {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Encoding failed"))), mimeType, quality);
		});
	}

	function buildFileName(exportSettings, width, height, extension) {
		const now = new Date();
		const pad = (value) => String(value).padStart(2, "0");
		const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
		const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const mood = MOODS[exportSettings.mood] ? exportSettings.mood : "custom";
		const colorSpaceSuffix = exportSettings.colorSpace === "p3" ? "-p3" : "";
		return `blends-${mood}-${date}-${time}-${width}x${height}${colorSpaceSuffix}.${extension}`;
	}

	function downloadBlob(blob, fileName) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = fileName;
		document.body.appendChild(link);
		link.click();
		link.remove();
		// Revoking immediately can cancel the download in some browsers.
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}

	async function exportWallpaper() {
		const saveButton = element("save-button");
		const status = element("save-status");
		const progress = element("save-progress");
		const progressBar = element("save-progress-bar");
		const { width, height } = getOutputSize();

		if (width * height > MAX_EXPORT_PIXELS) {
			status.textContent = `${width} × ${height} is too large to render here. Keep it under about 16.7 megapixels.`;
			return;
		}

		// Snapshot, so changes made while the export runs don't leak into it.
		const exportSettings = JSON.parse(JSON.stringify(settings));
		const format = FILE_FORMATS[exportSettings.fileFormat] || FILE_FORMATS.png;

		saveButton.disabled = true;
		progress.hidden = false;
		progressBar.style.width = "0%";

		try {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d", canvasContextOptions(exportSettings.colorSpace));
			if (!context) {
				throw new Error("Canvas unavailable");
			}

			const imageData = createImageData(context, width, height, exportSettings.colorSpace);
			const scene = buildScene(exportSettings, width, height, exportSettings.colorSpace);
			const rowsPerChunk = Math.max(1, Math.floor(EXPORT_PIXELS_PER_CHUNK / width));

			for (let row = 0; row < height; row += rowsPerChunk) {
				renderRows(scene, imageData.data, row, Math.min(height, row + rowsPerChunk));
				const percent = Math.min(100, Math.round((row + rowsPerChunk) / height * 100));
				progressBar.style.width = percent + "%";
				status.textContent = `Rendering ${percent}%`;
				await yieldToBrowser();
			}
			context.putImageData(imageData, 0, 0);

			status.textContent = "Encoding " + format.label;
			await yieldToBrowser();
			const quality = format.mimeType === "image/png" ? undefined : exportSettings.quality;
			let blob = await canvasToBlob(canvas, format.mimeType, quality);
			if (blob.type && blob.type !== format.mimeType) {
				throw new Error("Format not supported");
			}
			if (exportSettings.colorSpace === "p3") {
				blob = await tagWithDisplayP3(blob, exportSettings.fileFormat, width, height);
			}

			// Release the full-size canvas memory right away; it can be over 60 MB.
			canvas.width = 0;
			canvas.height = 0;

			const fileName = buildFileName(exportSettings, width, height, format.extension);
			downloadBlob(blob, fileName);
			status.textContent = `Downloaded ${fileName}`;
		} catch (error) {
			status.textContent = "Rendering failed. Try a smaller size.";
		} finally {
			saveButton.disabled = false;
			progress.hidden = true;
		}
	}

	/* ---------- Startup ---------- */

	populateSelects();
	bindControls();
	syncControls();
	layoutPreviewFrame();
	onPaletteChanged();

})(window.Blends);
