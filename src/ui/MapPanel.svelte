<script>
    import { untrack } from 'svelte';

    let {
        style = '',
        tileProviders = [],
        customMaps = [],
        initialActiveProviderId = '',
        initialSunDate = new Date(),
        initialShadows = true,
        onLayerSwitch = () => {},
        onSunChange = () => {},
        onShadowsChange = () => {},
        onSelectToggle = () => {},
        onAspectChange = () => {},
        onFetchTracks = () => {},
        onAddTracksToPreview = () => {},
        onDownloadTracks = () => null,
        onUploadTracks = () => 0,
        onFetchBuildings = () => {},
        onAddBuildingsToPreview = () => {},
        onDownloadBuildings = () => null,
        onUploadBuildings = () => 0,
        onFetchStreets = () => {},
        onAddStreetsToPreview = () => {},
        onDownloadStreets = () => null,
        onUploadStreets = () => 0,
        initialZoom = 0,
        canCollapse = false,
        onCollapse = () => {},
    } = $props();

    let mountEl;
    export function getMount() { return mountEl; }

    // Live map zoom readout; pushed in from index.ts on every view change.
    let mapZoom = $state(untrack(() => initialZoom));
    export function setZoom(z) { mapZoom = z; }

    let menuOpen = $state(false);
    // Second slide-out (track icon button); mutually exclusive with the map menu so the two
    // right-hand panels never overlap.
    let tracksMenuOpen = $state(false);
    let activeProviderId = $state(untrack(() => initialActiveProviderId));
    let providerList = $state(untrack(() => tileProviders));
    let customList = $state(untrack(() => customMaps));
    let dateValue = $state(untrack(() => toDateInput(initialSunDate)));
    let minutesOfDay = $state(untrack(() => initialSunDate.getHours() * 60 + initialSunDate.getMinutes()));
    let shadowsOn = $state(untrack(() => initialShadows));
    // Which selection tool is active: 'none' | 'rectangle' | 'oval'.
    let activeTool = $state('none');
    // True once a selection exists, so the "download tracks" button can appear. Pushed in
    // from index.ts as the selection is drawn / cleared / restored.
    let hasSelection = $state(false);
    // True once a download has returned tracks for the current selection, gating the
    // "Add to preview" button. Reset whenever the selection changes (tracks no longer match).
    let tracksReady = $state(false);
    let buildingsReady = $state(false);
    let streetsReady = $state(false);
    export function setHasSelection(has) { hasSelection = has; tracksReady = false; buildingsReady = false; streetsReady = false; }
    // Track-download button feedback: idle label, a busy flag, and a transient result note.
    let tracksBusy = $state(false);
    let tracksLabel = $state('Download tracks');
    // Building-download button feedback (mirror of the track equivalents).
    let buildingsBusy = $state(false);
    let buildingsLabel = $state('Download buildings');
    // Street-download button feedback (mirror of the track equivalents).
    let streetsBusy = $state(false);
    let streetsLabel = $state('Download streets');

    async function fetchTracks() {
        if (tracksBusy) return;
        tracksBusy = true;
        tracksLabel = 'Downloading…';
        try {
            const count = await onFetchTracks();
            tracksReady = count > 0;
            tracksLabel = count ? `${count} tracks` : 'No tracks found';
        } catch {
            tracksLabel = 'Download failed';
        } finally {
            tracksBusy = false;
            setTimeout(() => tracksLabel = 'Download tracks', 2500);
        }
    }

    // Save the raw downloaded JSON (tracks or buildings) to a file the user can keep and re-upload.
    function downloadJson(getJson, filename) {
        const json = getJson();
        if (!json) return;
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Hidden file inputs behind the Upload buttons; reading a saved file re-ingests its data
    // exactly like a fresh download (overlay + enables "Add to preview").
    let trackFileInput = $state();
    async function uploadTracks(e) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-selecting the same file fires onchange again
        if (!file) return;
        try {
            const json = JSON.parse(await file.text());
            const count = onUploadTracks(json);
            tracksReady = count > 0;
            tracksLabel = count ? `${count} tracks` : 'No tracks found';
        } catch {
            tracksLabel = 'Upload failed';
        } finally {
            setTimeout(() => tracksLabel = 'Download tracks', 2500);
        }
    }

    async function fetchBuildings() {
        if (buildingsBusy) return;
        buildingsBusy = true;
        buildingsLabel = 'Downloading…';
        try {
            const count = await onFetchBuildings();
            buildingsReady = count > 0;
            buildingsLabel = count ? `${count} buildings` : 'No buildings found';
        } catch {
            buildingsLabel = 'Download failed';
        } finally {
            buildingsBusy = false;
            setTimeout(() => buildingsLabel = 'Download buildings', 2500);
        }
    }

    let buildingFileInput = $state();
    async function uploadBuildings(e) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const json = JSON.parse(await file.text());
            const count = onUploadBuildings(json);
            buildingsReady = count > 0;
            buildingsLabel = count ? `${count} buildings` : 'No buildings found';
        } catch {
            buildingsLabel = 'Upload failed';
        } finally {
            setTimeout(() => buildingsLabel = 'Download buildings', 2500);
        }
    }

    async function fetchStreets() {
        if (streetsBusy) return;
        streetsBusy = true;
        streetsLabel = 'Downloading…';
        try {
            const count = await onFetchStreets();
            streetsReady = count > 0;
            streetsLabel = count ? `${count} streets` : 'No streets found';
        } catch {
            streetsLabel = 'Download failed';
        } finally {
            streetsBusy = false;
            setTimeout(() => streetsLabel = 'Download streets', 2500);
        }
    }

    let streetFileInput = $state();
    async function uploadStreets(e) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const json = JSON.parse(await file.text());
            const count = onUploadStreets(json);
            streetsReady = count > 0;
            streetsLabel = count ? `${count} streets` : 'No streets found';
        } catch {
            streetsLabel = 'Upload failed';
        } finally {
            setTimeout(() => streetsLabel = 'Download streets', 2500);
        }
    }
    // Aspect-ratio lock for drawing/resizing (session-only). 'free' or a 'w:h' preset, or
    // 'custom' with the two numbers below. Locked to width:height = halfX/halfY.
    let aspectMode = $state('free');
    let customW = $state(4);
    let customH = $state(3);

    function aspectRatio() {
        if (aspectMode === 'free') return null;
        if (aspectMode === 'custom') return customW > 0 && customH > 0 ? customW / customH : null;
        const [w, h] = aspectMode.split(':').map(Number);
        return h > 0 ? w / h : null;
    }
    function emitAspect() { onAspectChange(aspectRatio()); }

    let sunEnabled = $derived(!!customList.find(c => c.id === activeProviderId)?.sun);
    let shadowsCapable = $derived(!!customList.find(c => c.id === activeProviderId)?.shadows);
    let timeLabel = $derived(formatTime(minutesOfDay));

    // Group the menu into sections: ungrouped tile layers under "Map Source", then one
    // section per named category (e.g. Mapterhorn, AWS Terrain) holding that source's raw
    // layer + its 3D maps, then any ungrouped custom maps under "Custom Maps".
    let sections = $derived(buildSections(providerList, customList));

    function buildSections(providers, customs) {
        const order = [];
        for (const e of [...providers, ...customs]) {
            if (e.category && !order.includes(e.category)) order.push(e.category);
        }
        const result = [];
        const looseProviders = providers.filter(p => !p.category);
        if (looseProviders.length) result.push({ title: 'Map Source', items: looseProviders });
        const rank = (name) => name === 'Raw' ? 0 : name.startsWith('2D Hillshade') ? 1 : name.startsWith('3D Hillshade') ? 2 : 3;
        for (const cat of order) {
            const items = [
                ...providers.filter(p => p.category === cat),
                ...customs.filter(c => c.category === cat),
            ].sort((a, b) => rank(a.name) - rank(b.name));
            result.push({ title: cat, items });
        }
        const looseCustoms = customs.filter(c => !c.category);
        if (looseCustoms.length) result.push({ title: 'Custom Maps', items: looseCustoms });
        return result;
    }

    // Accordion: one section open at a time, so a long source list stays manageable. The
    // section holding the active layer auto-opens; clicking a header toggles it.
    let openSection = $state(null);
    let activeSectionTitle = $derived(sections.find(s => s.items.some(i => i.id === activeProviderId))?.title ?? null);
    // Keep the active layer's section open (until the user manually opens another). untrack
    // openSection so this only re-fires when the *active section* changes, not on every toggle.
    $effect(() => {
        const title = activeSectionTitle;
        untrack(() => { if (title && openSection !== title) openSection = title; });
    });
    function toggleSection(title) { openSection = openSection === title ? null : title; }

    // Pushed in from index.ts.
    export function setTileProviders(providers) { providerList = providers; }
    export function setCustomMaps(maps) { customList = maps; }
    export function setActiveProvider(id) { activeProviderId = id; }
    export function setSelectActive(active) { activeTool = active ? 'rectangle' : 'none'; }
    // Highlight the right tool when a saved selection is restored (rectangle | oval | null).
    export function setSelectTool(tool) { activeTool = tool ?? 'none'; }

    function toggleTool(tool) {
        if (activeTool === tool) {
            activeTool = 'none';
            onSelectToggle(false, tool);
        } else {
            activeTool = tool;
            onSelectToggle(true, tool);
        }
    }

    function handleLayerSwitch(id) {
        if (id === activeProviderId) return;
        activeProviderId = id;
        menuOpen = false;
        onLayerSwitch(id);
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function toDateInput(date) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }
    function formatTime(minutes) {
        return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    }
    function composeSunDate() {
        const [y, m, d] = dateValue.split('-').map(Number);
        return new Date(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
    }
    function emitSun() {
        if (dateValue) onSunChange(composeSunDate());
    }
    function setSunNow() {
        const now = new Date();
        dateValue = toDateInput(now);
        minutesOfDay = now.getHours() * 60 + now.getMinutes();
        onSunChange(now);
    }
    function toggleShadows() {
        onShadowsChange(shadowsOn);
    }
</script>

<div class="panel panel-map" {style}>
    <div class="panel-mount" id="map-mount" bind:this={mountEl}></div>

    <!-- Selection toolbar (below the map's zoom +/- control) -->
    <div class="absolute top-20 left-4 z-[1000] flex flex-col gap-2">
        <button
            class="btn btn-square shadow-md border-0 {activeTool === 'rectangle' ? 'btn-primary' : 'bg-base-100'}"
            title="Select rectangular area"
            aria-label="Select rectangular area"
            onclick={() => toggleTool('rectangle')}
        >⬚</button>
        <button
            class="btn btn-square shadow-md border-0 {activeTool === 'oval' ? 'btn-primary' : 'bg-base-100'}"
            title="Select oval area"
            aria-label="Select oval area"
            onclick={() => toggleTool('oval')}
        >◯</button>

        {#if activeTool !== 'none'}
            <!-- Aspect-ratio lock: snaps the selection to a frame ratio (1:1 = square/circle). -->
            <select
                class="select select-sm bg-base-100 shadow-md border-0 w-24"
                title="Lock aspect ratio"
                aria-label="Lock aspect ratio"
                bind:value={aspectMode}
                onchange={emitAspect}
            >
                <option value="free">Free</option>
                <option value="1:1">1:1</option>
                <option value="3:2">3:2</option>
                <option value="4:3">4:3</option>
                <option value="16:9">16:9</option>
                <option value="custom">Custom</option>
            </select>
            {#if aspectMode === 'custom'}
                <div class="flex items-center gap-1 bg-base-100 shadow-md rounded px-2 py-1">
                    <input type="number" min="1" step="1" class="input input-xs input-bordered w-12 text-center"
                        bind:value={customW} oninput={emitAspect} aria-label="Ratio width" />
                    <span class="text-sm opacity-60">:</span>
                    <input type="number" min="1" step="1" class="input input-xs input-bordered w-12 text-center"
                        bind:value={customH} oninput={emitAspect} aria-label="Ratio height" />
                </div>
            {/if}
        {/if}
    </div>

    <!-- Menu buttons (map menu + tracks menu) stacked top-right -->
    <div class="absolute top-4 right-4 z-[1000] flex flex-col gap-2">
        <button
            class="btn btn-square bg-base-100 shadow-md border-0"
            aria-label="Open map menu"
            onclick={() => { menuOpen = true; tracksMenuOpen = false; }}
        >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        </button>
        <button
            class="btn btn-square bg-base-100 shadow-md border-0"
            aria-label="Open OpenStreetMap data menu"
            title="OpenStreetMap data"
            onclick={() => { tracksMenuOpen = true; menuOpen = false; }}
        >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6" cy="19" r="2"></circle>
                <circle cx="18" cy="5" r="2"></circle>
                <path d="M8 19h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6"></path>
            </svg>
        </button>
    </div>

    <!-- Live zoom readout (sits above the OL scale line at the bottom-left) -->
    <div class="absolute bottom-8 left-2 z-[1000] bg-base-100/90 shadow-md rounded px-2 py-0.5 text-xs font-mono tabular-nums pointer-events-none">
        z{mapZoom.toFixed(1)}
    </div>

    {#if canCollapse}
        <button class="collapse-btn btn btn-xs btn-circle bg-base-100 border-0 shadow" title="Hide map" onclick={onCollapse}>‹</button>
    {/if}

    {#if menuOpen}
        <button class="absolute inset-0 z-[1999] cursor-default bg-transparent border-0 p-0" aria-label="Close menu" onclick={() => menuOpen = false}></button>
    {/if}
    {#if tracksMenuOpen}
        <button class="absolute inset-0 z-[1999] cursor-default bg-transparent border-0 p-0" aria-label="Close tracks menu" onclick={() => tracksMenuOpen = false}></button>
    {/if}

    <div class="absolute inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
        <div class="flex items-center justify-between px-4 py-3 bg-primary text-primary-content">
            <h2 class="text-lg font-semibold">Map Controls</h2>
            <button class="btn btn-ghost btn-sm btn-circle text-primary-content" onclick={() => menuOpen = false}>✕</button>
        </div>
        <div class="overflow-y-auto flex-1 py-2">
            {#each sections as section (section.title)}
                {@const isOpen = openSection === section.title}
                {@const hasActive = section.items.some(i => i.id === activeProviderId)}
                <button
                    class="w-full flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-base-300 {hasActive ? 'opacity-90' : 'opacity-60'}"
                    onclick={() => toggleSection(section.title)}
                >
                    <span class="text-[0.6rem] transition-transform duration-150 {isOpen ? 'rotate-90' : ''}">▶</span>
                    <span class="flex-1 text-left">{section.title}</span>
                    {#if hasActive && !isOpen}<span class="badge badge-primary badge-xs"></span>{/if}
                    <span class="opacity-50 font-normal normal-case">{section.items.length}</span>
                </button>
                {#if isOpen}
                    <ul class="menu px-2 pt-0">
                        {#each section.items as item (item.id)}
                            <li>
                                <button class={item.id === activeProviderId ? 'active' : ''} onclick={() => handleLayerSwitch(item.id)}>
                                    <span>{item.icon}</span>
                                    {item.name}
                                </button>
                            </li>
                        {/each}
                    </ul>
                {/if}
            {/each}

            {#if sunEnabled}
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Sun</div>
                <div class="px-4 py-2 flex flex-col gap-2">
                    <input type="date" class="input input-sm input-bordered w-full" bind:value={dateValue} onchange={emitSun} />
                    <div class="flex items-center gap-2">
                        <input type="range" min="0" max="1439" step="5" class="range range-sm flex-1" bind:value={minutesOfDay} oninput={emitSun} />
                        <span class="text-sm font-mono tabular-nums w-12 text-right">{timeLabel}</span>
                    </div>
                    {#if shadowsCapable}
                        <label class="flex items-center gap-2 cursor-pointer py-1">
                            <input type="checkbox" class="toggle toggle-sm" bind:checked={shadowsOn} onchange={toggleShadows} />
                            <span class="text-sm">Cast shadows</span>
                        </label>
                    {/if}
                    <button class="btn btn-sm btn-outline" onclick={setSunNow}>Now</button>
                </div>
            {/if}
        </div>
    </div>

    <!-- OpenStreetMap data slide-out: download / reuse tracks + buildings for the selection. -->
    <div class="absolute inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {tracksMenuOpen ? 'translate-x-0' : 'translate-x-full'}">
        <div class="flex items-center justify-between px-4 py-3 bg-primary text-primary-content">
            <h2 class="text-lg font-semibold">OpenStreetMap data</h2>
            <button class="btn btn-ghost btn-sm btn-circle text-primary-content" onclick={() => tracksMenuOpen = false}>✕</button>
        </div>
        <div class="overflow-y-auto flex-1 py-2">
            {#if !hasSelection}
                <p class="px-4 py-2 text-sm opacity-60">Select an area on the map to download OpenStreetMap data for it.</p>
            {:else}
                <!-- Tracks -->
                <div class="px-4 py-1 text-xs font-bold uppercase tracking-wider opacity-50">Tracks</div>
                <div class="px-4 py-2 flex flex-col gap-2">
                    <button class="btn btn-sm btn-block" title="Download tracks in the selected area" onclick={fetchTracks} disabled={tracksBusy}>
                        {#if tracksBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
                        {tracksLabel}
                    </button>
                    <button class="btn btn-sm btn-block" title="Add the downloaded tracks to the 3D preview" onclick={onAddTracksToPreview} disabled={!tracksReady}>Add to preview</button>
                    <button class="btn btn-sm btn-block" title="Download the raw track data as a JSON file" onclick={() => downloadJson(onDownloadTracks, 'tracks.json')} disabled={!tracksReady}>Download JSON</button>
                    <button class="btn btn-sm btn-block" title="Load tracks from a previously downloaded JSON file" onclick={() => trackFileInput.click()}>Upload JSON</button>
                    <input type="file" accept=".json,application/json" bind:this={trackFileInput} onchange={uploadTracks} class="hidden" />
                </div>

                <!-- Buildings -->
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Buildings</div>
                <div class="px-4 py-2 flex flex-col gap-2">
                    <button class="btn btn-sm btn-block" title="Download building footprints in the selected area" onclick={fetchBuildings} disabled={buildingsBusy}>
                        {#if buildingsBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
                        {buildingsLabel}
                    </button>
                    <button class="btn btn-sm btn-block" title="Add the downloaded buildings to the 3D preview" onclick={onAddBuildingsToPreview} disabled={!buildingsReady}>Add to preview</button>
                    <button class="btn btn-sm btn-block" title="Download the raw building data as a JSON file" onclick={() => downloadJson(onDownloadBuildings, 'buildings.json')} disabled={!buildingsReady}>Download JSON</button>
                    <button class="btn btn-sm btn-block" title="Load buildings from a previously downloaded JSON file" onclick={() => buildingFileInput.click()}>Upload JSON</button>
                    <input type="file" accept=".json,application/json" bind:this={buildingFileInput} onchange={uploadBuildings} class="hidden" />
                </div>

                <!-- Streets (car roads) -->
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Streets</div>
                <div class="px-4 py-2 flex flex-col gap-2">
                    <button class="btn btn-sm btn-block" title="Download streets (car roads) in the selected area" onclick={fetchStreets} disabled={streetsBusy}>
                        {#if streetsBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
                        {streetsLabel}
                    </button>
                    <button class="btn btn-sm btn-block" title="Add the downloaded streets to the 3D preview" onclick={onAddStreetsToPreview} disabled={!streetsReady}>Add to preview</button>
                    <button class="btn btn-sm btn-block" title="Download the raw street data as a JSON file" onclick={() => downloadJson(onDownloadStreets, 'streets.json')} disabled={!streetsReady}>Download JSON</button>
                    <button class="btn btn-sm btn-block" title="Load streets from a previously downloaded JSON file" onclick={() => streetFileInput.click()}>Upload JSON</button>
                    <input type="file" accept=".json,application/json" bind:this={streetFileInput} onchange={uploadStreets} class="hidden" />
                </div>
            {/if}
        </div>
    </div>
</div>
