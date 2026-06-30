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
        // OSM data: the feature list to render ({id,label,noun,hasRadius}) + generic callbacks.
        osmFeatures = [],
        onOsmFetch = () => 0,
        onOsmAddToPreview = () => {},
        onOsmDownload = () => null,
        onOsmUpload = () => 0,
        onOsmSelectElement = () => {},
        onOsmDeleteElement = () => {},
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
    // Per-feature download UI state, keyed by feature id: { busy, label, ready }. Generic over the
    // registry so a new feature renders with no extra wiring. `ready` gates "Add to preview" and is
    // reset whenever the selection changes (the download no longer matches the new area).
    const idleLabel = (f) => `Download ${f.noun}`;
    let osmState = $state(untrack(() =>
        Object.fromEntries(osmFeatures.map(f => [f.id, { busy: false, label: idleLabel(f), ready: false }]))));
    // The object list per feature ({id,label}[]) and the single selected element (map ↔ list),
    // both pushed in from index.ts. The list is a vector-editor-style object panel.
    let osmElements = $state(untrack(() => Object.fromEntries(osmFeatures.map(f => [f.id, []]))));
    let osmSelected = $state(null); // { featureId, elementId } | null
    export function setOsmElements(id, elements) { osmElements[id] = elements; }
    export function setOsmSelected(featureId, elementId) {
        osmSelected = featureId !== null && elementId !== null ? { featureId, elementId } : null;
        // Selecting an element (e.g. by clicking it on the map) opens the OSM-data menu so the user
        // sees the matching list entry highlighted — the map ↔ list connection.
        if (osmSelected) { tracksMenuOpen = true; menuOpen = false; }
    }
    const isSelected = (fid, eid) => osmSelected?.featureId === fid && osmSelected?.elementId === eid;
    // Scroll the selected row into view once the menu/list has rendered (it stays in the DOM even
    // when the panel is slid off-screen, so the query works regardless of open state).
    $effect(() => {
        const sel = osmSelected;
        if (!sel) return;
        requestAnimationFrame(() => {
            document.querySelector(`[data-osm-el="${sel.featureId}:${sel.elementId}"]`)?.scrollIntoView({ block: 'nearest' });
        });
    });
    export function setHasSelection(has) {
        hasSelection = has;
        osmSelected = null;
        for (const f of osmFeatures) { osmState[f.id].ready = false; osmElements[f.id] = []; }
    }

    async function fetchOsm(f) {
        const st = osmState[f.id];
        if (st.busy) return;
        st.busy = true;
        st.label = 'Downloading…';
        try {
            const count = await onOsmFetch(f.id);
            st.ready = count > 0;
            st.label = count ? `${count} ${f.noun}` : `No ${f.noun} found`;
        } catch {
            st.label = 'Download failed';
        } finally {
            st.busy = false;
            setTimeout(() => st.label = idleLabel(f), 2500);
        }
    }

    // Save the raw downloaded JSON to a file the user can keep and re-upload.
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

    // One hidden file input reused for every feature; `uploadTargetId` remembers which Upload button
    // opened it. Reading a saved file re-ingests its data exactly like a fresh download.
    let osmFileInput = $state();
    let uploadTargetId = null;
    function pickUpload(id) { uploadTargetId = id; osmFileInput.click(); }
    async function uploadOsm(e) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-selecting the same file fires onchange again
        const f = osmFeatures.find(x => x.id === uploadTargetId);
        if (!file || !f) return;
        const st = osmState[f.id];
        try {
            const json = JSON.parse(await file.text());
            const count = onOsmUpload(f.id, json);
            st.ready = count > 0;
            st.label = count ? `${count} ${f.noun}` : `No ${f.noun} found`;
        } catch {
            st.label = 'Upload failed';
        } finally {
            setTimeout(() => st.label = idleLabel(f), 2500);
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
                <!-- One section per registry feature; entirely data-driven from `osmFeatures`. -->
                {#each osmFeatures as f (f.id)}
                    {@const st = osmState[f.id]}
                    {@const elements = osmElements[f.id] ?? []}
                    <div class="px-4 py-1 mt-2 first:mt-0 text-xs font-bold uppercase tracking-wider opacity-50">
                        {f.label}{#if elements.length}<span class="ml-1 font-normal normal-case opacity-70">({elements.length})</span>{/if}
                    </div>
                    <div class="px-4 py-2 flex flex-col gap-2">
                        <button class="btn btn-sm btn-block" title="Download {f.noun} in the selected area" onclick={() => fetchOsm(f)} disabled={st.busy}>
                            {#if st.busy}<span class="loading loading-spinner loading-xs"></span>{/if}
                            {st.label}
                        </button>
                        <button class="btn btn-sm btn-block" title="Add the downloaded {f.noun} to the 3D preview" onclick={() => onOsmAddToPreview(f.id)} disabled={!st.ready}>Add to preview</button>
                        <button class="btn btn-sm btn-block" title="Download the {f.noun} (with your deletions) as a JSON file" onclick={() => downloadJson(() => onOsmDownload(f.id), `${f.id}.json`)} disabled={!st.ready}>Download JSON</button>
                        <button class="btn btn-sm btn-block" title="Load {f.noun} from a previously downloaded JSON file" onclick={() => pickUpload(f.id)}>Upload JSON</button>
                    </div>
                    <!-- Object list: click a row to select it on the map (and vice-versa); × deletes it. -->
                    {#if elements.length}
                        <ul class="mx-4 mb-1 max-h-48 overflow-y-auto rounded border border-base-300 divide-y divide-base-300 text-sm">
                            {#each elements as el (el.id)}
                                <li data-osm-el="{f.id}:{el.id}" class="flex items-center {isSelected(f.id, el.id) ? 'bg-primary text-primary-content' : 'hover:bg-base-300'}">
                                    <button class="flex-1 text-left px-2 py-1 truncate bg-transparent border-0" title={el.label} onclick={() => onOsmSelectElement(f.id, el.id)}>{el.label}</button>
                                    <button class="px-2 py-1 opacity-70 hover:opacity-100 bg-transparent border-0" title="Delete this {f.label.toLowerCase()} element" aria-label="Delete element" onclick={() => onOsmDeleteElement(f.id, el.id)}>✕</button>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                {/each}
                <input type="file" accept=".json,application/json" bind:this={osmFileInput} onchange={uploadOsm} class="hidden" />
            {/if}
        </div>
    </div>
</div>
