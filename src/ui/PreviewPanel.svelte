<script>
    import { untrack } from 'svelte';

    let {
        style = '',
        canCollapse = false,
        onCollapse = () => {},
        dems = [],
        initialDemId = '',
        onDemChange = () => {},
        zoomMin = 0,
        zoomMax = 17,
        initialSettings = {},
        onSettingsChange = () => {},
        onGenerate = () => {},
        onSave = () => {},
        onResetCamera = () => {},
        onShareLink = () => '',
        onCancel = () => {},
    } = $props();

    let mountEl;
    export function getMount() { return mountEl; }

    let menuOpen = $state(false);
    let previewStats = $state(null);
    export function setPreviewStats(stats) { previewStats = stats; }

    // Build progress for the bottom loading bar: null = hidden, else { loaded, total }.
    let previewLoading = $state(null);
    export function setPreviewLoading(state) { previewLoading = state; }

    // The active elevation source, plus the zoom slider's range. Both can change at runtime
    // (switching DEMs moves the range), so they're local state, seeded from the props.
    let demId = $state(untrack(() => initialDemId));
    let zMin = $state(untrack(() => zoomMin));
    let zMax = $state(untrack(() => zoomMax));
    export function setZoomRange(min, max, hz) {
        zMin = min;
        zMax = max;
        if (hz != null) heightZoom = hz;
    }

    function selectDem(id) {
        if (id === demId) return;
        demId = id;
        onDemChange(id);
    }

    // Set the active source without firing onDemChange (index.ts already switched the DEM).
    export function setDem(id) { demId = id; }

    const memColor = { ok: '', warn: 'text-warning', high: 'text-error' };
    const fmt = n => n.toLocaleString();
    const fmtArea = n => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n >= 10 ? 1 : 2);
    // Height values: 1 decimal, trailing zeros dropped, sign + thousands separators kept.
    const fmtH = n => Number(n.toFixed(1)).toLocaleString();

    // 3D-build settings (UI + state only for now; Generate/Save just report them out).
    let heightZoom = $state(untrack(() => initialSettings.heightZoom ?? zoomMax));
    let resolutionLimit = $state(untrack(() => initialSettings.resolutionLimit ?? 256));
    let heightScale = $state(untrack(() => initialSettings.heightScale ?? 1));
    let socketEnabled = $state(untrack(() => initialSettings.socketEnabled ?? false));
    let socketSize = $state(untrack(() => initialSettings.socketSize ?? 0));
    let tilesEnabled = $state(untrack(() => initialSettings.tilesEnabled ?? false));
    let tilesX = $state(untrack(() => initialSettings.tilesX ?? 1));
    let tilesY = $state(untrack(() => initialSettings.tilesY ?? 1));
    let waterEnabled = $state(untrack(() => initialSettings.waterEnabled ?? false));
    let waterCutoff = $state(untrack(() => initialSettings.waterCutoff ?? 0));
    let waterLevel = $state(untrack(() => initialSettings.waterLevel ?? 0));
    let lowCutEnabled = $state(untrack(() => initialSettings.lowCutEnabled ?? false));
    let lowCutLevel = $state(untrack(() => initialSettings.lowCutLevel ?? 0));
    let tracksEnabled = $state(untrack(() => initialSettings.tracksEnabled ?? false));
    let trackRaise = $state(untrack(() => initialSettings.trackRaise ?? 2));
    let trackRadius = $state(untrack(() => initialSettings.trackRadius ?? 10));
    let buildingsEnabled = $state(untrack(() => initialSettings.buildingsEnabled ?? false));
    let buildingRaise = $state(untrack(() => initialSettings.buildingRaise ?? 6));
    let smoothShading = $state(untrack(() => initialSettings.smoothShading ?? true));

    // Whether OSM tracks have been added from the map; gates the Tracks section's visibility.
    let tracksAvailable = $state(false);
    export function setTracksAvailable(has) { tracksAvailable = has; }
    // Same for buildings.
    let buildingsAvailable = $state(false);
    export function setBuildingsAvailable(has) { buildingsAvailable = has; }

    function settings() {
        return { heightZoom, resolutionLimit, heightScale, socketEnabled, socketSize, tilesEnabled, tilesX, tilesY, waterEnabled, waterCutoff, waterLevel, lowCutEnabled, lowCutLevel, tracksEnabled, trackRaise, trackRadius, buildingsEnabled, buildingRaise, smoothShading };
    }
    function emit() { onSettingsChange(settings()); }
    function selectAll(e) { e.target.select(); }

    let shareLabel = $state('Share link');
    async function shareLink() {
        const url = onShareLink();
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            shareLabel = 'Copied!';
        } catch {
            shareLabel = 'Copy failed';
        }
        setTimeout(() => shareLabel = 'Share link', 1500);
    }
</script>

<div class="panel panel-preview" {style}>
    <div class="panel-mount" id="preview-mount" bind:this={mountEl}></div>

    {#if previewStats}
        <div class="absolute top-4 left-4 z-[1000] bg-base-100/80 backdrop-blur rounded shadow-md px-3 py-2 text-xs font-mono leading-5 pointer-events-none">
            <div>Selection: {fmt(previewStats.widthMeters)} × {fmt(previewStats.heightMeters)} m</div>
            <div>Min / Max height: {fmtH(previewStats.minHeight)} / {fmtH(previewStats.maxHeight)} m</div>
            <div>Detail: {fmt(previewStats.gridCols)} × {fmt(previewStats.gridRows)} vtx ({fmtArea(previewStats.metersPerVertex)} m²/vtx)</div>
            <div>Heightmap zoom: z{previewStats.zoom}</div>
            <div>Vertices: {fmt(previewStats.vertices)}</div>
            <div>Triangles: {fmt(previewStats.triangles)}</div>
            <div class={memColor[previewStats.memoryLevel]}>Memory: ~{previewStats.memoryText}</div>
            <div>Min / Max thickness: {fmtH(previewStats.minThickness)} / {fmtH(previewStats.maxThickness)} units</div>
        </div>
    {/if}

    {#if previewLoading}
        <div class="absolute bottom-0 left-0 right-0 z-[2100] bg-base-100/95 backdrop-blur border-t border-base-300 px-4 py-2 flex items-center gap-3">
            <span class="text-sm whitespace-nowrap">Building preview…</span>
            {#if previewLoading.total > 0}
                <progress class="progress progress-primary flex-1" value={previewLoading.loaded} max={previewLoading.total}></progress>
                <span class="text-xs font-mono tabular-nums whitespace-nowrap">{previewLoading.loaded} / {previewLoading.total} tiles</span>
            {:else}
                <progress class="progress progress-primary flex-1"></progress>
            {/if}
            <button class="btn btn-sm btn-error" onclick={onCancel}>Cancel</button>
        </div>
    {/if}

    <!-- 3D menu button -->
    <button
        class="btn btn-square bg-base-100 shadow-md absolute top-4 right-4 z-[1000] border-0"
        aria-label="Open 3D menu"
        onclick={() => menuOpen = true}
    >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
    </button>

    <!-- Reset camera to the default view -->
    <button
        class="btn btn-square bg-base-100 shadow-md absolute top-20 right-4 z-[1000] border-0"
        aria-label="Reset camera"
        title="Reset camera"
        onclick={onResetCamera}
    >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12a9 9 0 1 1 3 6.7"></path>
            <polyline points="3 21 3 15 9 15"></polyline>
        </svg>
    </button>

    {#if canCollapse}
        <button class="collapse-btn btn btn-xs btn-circle bg-base-100 border-0 shadow" title="Hide 3D view" onclick={onCollapse}>›</button>
    {/if}

    {#if menuOpen}
        <button class="absolute inset-0 z-[1999] cursor-default bg-transparent border-0 p-0" aria-label="Close menu" onclick={() => menuOpen = false}></button>
    {/if}

    <div class="absolute inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
        <div class="flex items-center justify-between px-4 py-3 bg-secondary text-secondary-content">
            <h2 class="text-lg font-semibold">3D View</h2>
            <button class="btn btn-ghost btn-sm btn-circle text-secondary-content" onclick={() => menuOpen = false}>✕</button>
        </div>

        <div class="overflow-y-auto flex-1 py-2">
            <!-- Heightmap detail -->
            <div class="px-4 py-1 text-xs font-bold uppercase tracking-wider opacity-50">Heightmap</div>
            <div class="px-4 py-2 flex flex-col gap-3">
                {#if dems.length > 1}
                    <label class="flex flex-col gap-1">
                        <span class="text-sm">Source</span>
                        <select
                            class="select select-sm select-bordered w-full"
                            value={demId}
                            onchange={(e) => selectDem(e.currentTarget.value)}
                        >
                            {#each dems as d (d.id)}
                                <option value={d.id}>{d.name}</option>
                            {/each}
                        </select>
                    </label>
                {/if}
                <div class="flex flex-col gap-1">
                    <span class="text-sm flex items-center justify-between">Zoom <span class="font-mono">z{heightZoom}</span></span>
                    <input type="range" min={zMin} max={zMax} step="1" class="range range-sm" bind:value={heightZoom} onchange={emit} />
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-sm flex-1">Resolution limit</span>
                    <input type="number" min="64" step="64" class="input input-sm input-bordered w-24" bind:value={resolutionLimit} onfocus={selectAll} onchange={emit} />
                    <span class="text-sm opacity-60">vtx</span>
                </div>
                <div class="flex flex-col gap-1">
                    <span class="text-sm flex items-center justify-between">Height scale <span class="font-mono">{heightScale}×</span></span>
                    <input type="range" min="0.1" max="5" step="0.1" class="range range-sm" bind:value={heightScale} onchange={emit} />
                </div>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={waterEnabled} onchange={emit} />
                        <span class="text-sm">Water cutoff</span>
                    </label>
                    {#if waterEnabled}
                        <div class="flex items-center gap-2">
                            <span class="text-sm flex-1">Below</span>
                            <input type="number" step="1" class="input input-sm input-bordered w-24" bind:value={waterCutoff} onfocus={selectAll} onchange={emit} />
                            <span class="text-sm opacity-60">m</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-sm flex-1">Water at</span>
                            <input type="number" step="1" class="input input-sm input-bordered w-24" bind:value={waterLevel} onfocus={selectAll} onchange={emit} />
                            <span class="text-sm opacity-60">m</span>
                        </div>
                    {/if}
                </div>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={lowCutEnabled} onchange={emit} />
                        <span class="text-sm">Cut-off hole</span>
                    </label>
                    {#if lowCutEnabled}
                        <div class="flex items-center gap-2">
                            <span class="text-sm flex-1">Remove below</span>
                            <input type="number" step="1" class="input input-sm input-bordered w-24" bind:value={lowCutLevel} onfocus={selectAll} onchange={emit} />
                            <span class="text-sm opacity-60">m</span>
                        </div>
                    {/if}
                </div>
            </div>

            <!-- Socket -->
            <div class="px-4 py-2">
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" bind:checked={socketEnabled} onchange={emit} />
                    <span class="text-sm">Make socket</span>
                </label>
                {#if socketEnabled}
                    <div class="mt-2 flex items-center gap-2">
                        <span class="text-sm">Size</span>
                        <input type="number" min="0" step="0.1" class="input input-sm input-bordered w-24" bind:value={socketSize} onfocus={selectAll} onchange={emit} />
                        <span class="text-sm opacity-60">m</span>
                    </div>
                {/if}
            </div>

            <!-- Tiles -->
            <div class="px-4 py-2">
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" bind:checked={tilesEnabled} onchange={emit} />
                    <span class="text-sm">Tiles</span>
                </label>
                {#if tilesEnabled}
                    <div class="mt-2 flex items-center gap-2">
                        <input type="number" min="1" step="1" class="input input-sm input-bordered w-16 text-center" bind:value={tilesX} onfocus={selectAll} onchange={emit} />
                        <span class="text-sm opacity-60">×</span>
                        <input type="number" min="1" step="1" class="input input-sm input-bordered w-16 text-center" bind:value={tilesY} onfocus={selectAll} onchange={emit} />
                    </div>
                {/if}
            </div>

            <!-- Tracks (only once OSM tracks have been added from the map) -->
            {#if tracksAvailable}
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Tracks</div>
                <div class="px-4 py-2">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={tracksEnabled} onchange={emit} />
                        <span class="text-sm">Raise along tracks</span>
                    </label>
                    {#if tracksEnabled}
                        <div class="mt-2 flex items-center gap-2">
                            <span class="text-sm flex-1">Raise by</span>
                            <input type="number" step="0.5" class="input input-sm input-bordered w-24" bind:value={trackRaise} onfocus={selectAll} onchange={emit} />
                            <span class="text-sm opacity-60">m</span>
                        </div>
                        <div class="mt-2 flex items-center gap-2">
                            <span class="text-sm flex-1">Within</span>
                            <input type="number" min="0" step="1" class="input input-sm input-bordered w-24" bind:value={trackRadius} onfocus={selectAll} onchange={emit} />
                            <span class="text-sm opacity-60">m</span>
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- Buildings (only once OSM buildings have been added from the map) -->
            {#if buildingsAvailable}
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Buildings</div>
                <div class="px-4 py-2">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={buildingsEnabled} onchange={emit} />
                        <span class="text-sm">Raise buildings</span>
                    </label>
                    {#if buildingsEnabled}
                        <div class="mt-2 flex items-center gap-2">
                            <span class="text-sm flex-1">Raise by</span>
                            <input type="number" step="0.5" class="input input-sm input-bordered w-24" bind:value={buildingRaise} onfocus={selectAll} onchange={emit} />
                            <span class="text-sm opacity-60">m</span>
                        </div>
                    {/if}
                </div>
            {/if}

            <!-- Preview (display only; does not affect the exported model) -->
            <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Preview</div>
            <div class="px-4 py-2">
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm" bind:checked={smoothShading} onchange={emit} />
                    <span class="text-sm">Smooth shading</span>
                </label>
            </div>

            <!-- Actions -->
            <div class="px-4 py-3 flex flex-col gap-2">
                <button class="btn btn-sm btn-primary" onclick={() => onGenerate(settings())}>Generate</button>
                <button class="btn btn-sm btn-outline" onclick={() => onSave(settings())}>Save</button>
                <button class="btn btn-sm btn-ghost bg-base-100" onclick={shareLink}>{shareLabel}</button>
            </div>
        </div>
    </div>
</div>
