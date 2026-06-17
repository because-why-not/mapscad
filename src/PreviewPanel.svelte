<script>
    import { untrack } from 'svelte';

    let {
        style = '',
        canCollapse = false,
        onCollapse = () => {},
        zoomMin = 0,
        zoomMax = 17,
        initialSettings = {},
        onSettingsChange = () => {},
        onGenerate = () => {},
        onSave = () => {},
    } = $props();

    let mountEl;
    export function getMount() { return mountEl; }

    let menuOpen = $state(false);
    let previewStats = $state(null);
    export function setPreviewStats(stats) { previewStats = stats; }

    const memColor = { ok: '', warn: 'text-warning', high: 'text-error' };
    const fmt = n => n.toLocaleString();
    const fmtArea = n => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(n >= 10 ? 1 : 2);

    // 3D-build settings (UI + state only for now; Generate/Save just report them out).
    let heightZoom = $state(untrack(() => initialSettings.heightZoom ?? zoomMax));
    let resolutionLimit = $state(untrack(() => initialSettings.resolutionLimit ?? 256));
    let heightScale = $state(untrack(() => initialSettings.heightScale ?? 1));
    let socketEnabled = $state(untrack(() => initialSettings.socketEnabled ?? false));
    let socketSize = $state(untrack(() => initialSettings.socketSize ?? 0));
    let tilesEnabled = $state(untrack(() => initialSettings.tilesEnabled ?? false));
    let tilesX = $state(untrack(() => initialSettings.tilesX ?? 1));
    let tilesY = $state(untrack(() => initialSettings.tilesY ?? 1));

    function settings() {
        return { heightZoom, resolutionLimit, heightScale, socketEnabled, socketSize, tilesEnabled, tilesX, tilesY };
    }
    function emit() { onSettingsChange(settings()); }
    function selectAll(e) { e.target.select(); }
</script>

<div class="panel panel-preview" {style}>
    <div class="panel-mount" id="preview-mount" bind:this={mountEl}></div>

    {#if previewStats}
        <div class="absolute top-4 left-4 z-[1000] bg-base-100/80 backdrop-blur rounded shadow-md px-3 py-2 text-xs font-mono leading-5 pointer-events-none">
            <div>Selection: {fmt(previewStats.widthMeters)} × {fmt(previewStats.heightMeters)} m</div>
            <div>Detail: {fmt(previewStats.gridCols)} × {fmt(previewStats.gridRows)} vtx ({fmtArea(previewStats.metersPerVertex)} m²/vtx)</div>
            <div>Heightmap zoom: z{previewStats.zoom}</div>
            <div>Vertices: {fmt(previewStats.vertices)}</div>
            <div>Triangles: {fmt(previewStats.triangles)}</div>
            <div class={memColor[previewStats.memoryLevel]}>Memory: ~{previewStats.memoryText}</div>
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
                <div class="flex flex-col gap-1">
                    <span class="text-sm flex items-center justify-between">Zoom <span class="font-mono">z{heightZoom}</span></span>
                    <input type="range" min={zoomMin} max={zoomMax} step="1" class="range range-sm" bind:value={heightZoom} oninput={emit} />
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-sm flex-1">Resolution limit</span>
                    <input type="number" min="64" step="64" class="input input-sm input-bordered w-24" bind:value={resolutionLimit} onfocus={selectAll} oninput={emit} />
                    <span class="text-sm opacity-60">vtx</span>
                </div>
                <div class="flex flex-col gap-1">
                    <span class="text-sm flex items-center justify-between">Height scale <span class="font-mono">{heightScale}×</span></span>
                    <input type="range" min="0.1" max="5" step="0.1" class="range range-sm" bind:value={heightScale} oninput={emit} />
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
                        <input type="number" min="0" step="0.1" class="input input-sm input-bordered w-24" bind:value={socketSize} onfocus={selectAll} oninput={emit} />
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
                        <input type="number" min="1" step="1" class="input input-sm input-bordered w-16 text-center" bind:value={tilesX} onfocus={selectAll} oninput={emit} />
                        <span class="text-sm opacity-60">×</span>
                        <input type="number" min="1" step="1" class="input input-sm input-bordered w-16 text-center" bind:value={tilesY} onfocus={selectAll} oninput={emit} />
                    </div>
                {/if}
            </div>

            <!-- Actions -->
            <div class="px-4 py-3 flex flex-col gap-2">
                <button class="btn btn-sm btn-primary" onclick={() => onGenerate(settings())}>Generate</button>
                <button class="btn btn-sm btn-outline" onclick={() => onSave(settings())}>Save</button>
            </div>
        </div>
    </div>
</div>
