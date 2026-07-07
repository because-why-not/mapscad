<script>
    import { untrack } from 'svelte';
    import OsmDataPanel from './OsmDataPanel.svelte';
    import Attribution from './Attribution.svelte';

    let {
        style = '',
        tileProviders = [],
        customMaps = [],
        initialActiveProviderId = '',
        onLayerSwitch = () => {},
        onSelectToggle = () => {},
        onAspectChange = () => {},
        onDataModeChange = () => {},
        // OSM data: the feature list to render ({id,label,noun,hasRadius}) + generic callbacks.
        features = [],
        onDownload = () => 0,
        onUpdatePreview = () => {},
        onSaveJson = () => null,
        onLoadJson = () => 0,
        onSelectElement = () => {},
        onSetEnabled = () => {},
        onDelete = () => {},
        onHoverElement = () => {},
        onMarksChange = () => {},
        onBoxSelectToggle = () => {},
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
    // Panel-level mode tabs: 'selection' (selection tools + map sources) and 'data'
    // (OpenStreetMap download/edit). The Data tab is gated on a selection existing — see dataEnabled.
    let activeTab = $state('selection');
    let activeProviderId = $state(untrack(() => initialActiveProviderId));
    let providerList = $state(untrack(() => tileProviders));
    let customList = $state(untrack(() => customMaps));
    // Which selection tool is active: 'none' | 'rectangle' | 'oval'.
    let activeTool = $state('none');
    // True once a selection exists, so the "download tracks" button can appear. Pushed in
    // from index.ts as the selection is drawn / cleared / restored.
    let hasSelection = $state(false);
    // Longest selection side in metres, pushed alongside hasSelection — the Data tab uses it to gate
    // each OSM download against its size limit.
    let selectionSide = $state(0);
    // The Data tab is only reachable once an area is selected.
    let dataEnabled = $derived(hasSelection);
    // True after the selection changed while away from the Data tab — the downloaded data is now
    // stale, so the next switch to Data reopens the drawer (the user likely needs to re-download).
    // Cleared once Data is opened. Plain switching between tabs otherwise leaves the drawer as-is.
    let selectionDirty = $state(false);
    // Tab clicks switch mode without forcing the drawer open; clicking the already-active tab toggles
    // it. Switching to Data after the selection changed reopens it (see selectionDirty above).
    function selectTab(tab) {
        if (tab === activeTab) { menuOpen = !menuOpen; return; }
        if (tab === 'data' && selectionDirty) { menuOpen = true; selectionDirty = false; }
        activeTab = tab;
    }
    // If the selection is cleared while the user is in Data mode, don't strand them there —
    // fall back to the Selection tab. untrack activeTab so this only fires on hasSelection flipping.
    $effect(() => {
        if (!hasSelection) untrack(() => { if (activeTab === 'data') activeTab = 'selection'; });
    });
    // Tell the map to lock + dim the selection while the Data tab is active (view-only), so the
    // user can't accidentally change the selection there. Leaving Data also turns the box tool off.
    $effect(() => {
        const inData = activeTab === 'data';
        onDataModeChange(inData);
        if (!inData) untrack(() => { if (boxSelectActive) { boxSelectActive = false; onBoxSelectToggle(false); } });
    });
    // The OSM data panel (child) owns all element state + the object list; index.ts's imperative
    // exports below just forward to it via this ref.
    let dataPanel = $state();
    export function setOsmElements(id, els) { dataPanel?.setElements(id, els); }
    export function setOsmSelected(featureId, elementId) { dataPanel?.setSelected(featureId, elementId); }
    export function addOsmMarks(fid, ids) { dataPanel?.addMarks(fid, ids); }

    // The transient box-select tool (Data tab only). Toggling it routes to the map; it never persists.
    // Marks land back in the child via addOsmMarks (index.ts → App → here → child).
    let boxSelectActive = $state(false);
    function toggleBoxSelect() { boxSelectActive = !boxSelectActive; onBoxSelectToggle(boxSelectActive); }

    export function setHasSelection(has, sideMeters = 0, resetData = true) {
        hasSelection = has;
        selectionSide = sideMeters; // longest selection side (m) — gates OSM downloads by size
        if (has) selectionDirty = true; // selection changed → Data should reopen so stale data gets re-downloaded
        // A cleared or brand-new selection resets the panel; an edit keeps the (re-projected) data and
        // instead flags it stale (see setOsmStale), so a slight nudge doesn't discard a download.
        if (resetData) dataPanel?.reset();
    }
    export function setOsmStale(id, stale) { dataPanel?.setStale(id, stale); }

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

    // Structured attribution for the selected map, shown at the top of the menu (undefined for
    // server maps that only carry a plain attribution string).
    let activeAttribution = $derived(
        (providerList.find(p => p.id === activeProviderId)
            ?? customList.find(c => c.id === activeProviderId))?.attribution
    );

    // Group the menu into sections: ungrouped public tile layers under "Map Source", then one
    // section per named category (public categories like Mapterhorn / AWS Terrain first, then
    // self-hosted-server categories), then everything from the local server that isn't in a
    // named category — plus any ungrouped custom maps — at the bottom under "Custom Maps".
    let sections = $derived(buildSections(providerList, customList));

    function buildSections(providers, customs) {
        const order = [];
        for (const e of [...providers, ...customs]) {
            if (e.category && !order.includes(e.category)) order.push(e.category);
        }
        const result = [];
        // Ungrouped public sources head the list; server-origin maps sink to the bottom.
        const loosePublic = providers.filter(p => !p.category && !p.server);
        if (loosePublic.length) result.push({ title: 'OpenStreetMaps', items: loosePublic });
        const rank = (name) => name === 'Raw' ? 0 : name.startsWith('2D Hillshade') ? 1 : name.startsWith('3D Hillshade') ? 2 : 3;
        // A category is "server" if any of its provider layers come from the local server.
        const catIsServer = (cat) => providers.some(p => p.category === cat && p.server);
        const pushCategories = (server) => {
            for (const cat of order) {
                if (catIsServer(cat) !== server) continue;
                const items = [
                    ...providers.filter(p => p.category === cat),
                    ...customs.filter(c => c.category === cat),
                ].sort((a, b) => rank(a.name) - rank(b.name));
                result.push({ title: cat, items });
            }
        };
        pushCategories(false); // public categories
        pushCategories(true);  // then server categories
        // Ungrouped server maps + ungrouped custom maps land at the bottom under "Custom Maps".
        const looseServer = providers.filter(p => !p.category && p.server);
        const looseCustoms = customs.filter(c => !c.category);
        const bottom = [...looseServer, ...looseCustoms];
        if (bottom.length) result.push({ title: 'Custom Maps', items: bottom });
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

</script>

<div class="panel panel-map" {style}>
    <div class="panel-mount" id="map-mount" bind:this={mountEl}></div>

    <!-- Selection toolbar (below the map's zoom +/- control). Hidden in Data mode so the
         selection can't be changed while the user works with downloaded data. -->
    {#if activeTab === 'selection'}
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
    {/if}

    <!-- Data-mode tool: drag a box on the map to select (mark) all OSM objects under it. -->
    {#if activeTab === 'data'}
    <div class="absolute top-20 left-4 z-[1000] flex flex-col gap-2">
        <button
            class="btn btn-square shadow-md border-0 {boxSelectActive ? 'btn-primary' : 'bg-base-100'}"
            title="Select objects by dragging a box"
            aria-label="Box-select objects"
            onclick={toggleBoxSelect}
        >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2">
                <rect x="3" y="3" width="18" height="18" rx="1"></rect>
            </svg>
        </button>
    </div>
    {/if}

    <!-- Mode tabs: switch the panel between Selection (tools + map sources) and Data
         (OpenStreetMap download/edit). Each opens the right-hand drawer to its content. The
         Data tab is disabled until an area is selected. -->
    <div class="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] join shadow-md">
        <button
            class="btn btn-sm join-item border-0 {activeTab === 'selection' ? 'btn-primary' : 'bg-base-100'}"
            onclick={() => selectTab('selection')}
        >Selection</button>
        <button
            class="btn btn-sm join-item border-0 {activeTab === 'data' ? 'btn-primary' : 'bg-base-100'}"
            disabled={!dataEnabled}
            title={dataEnabled ? 'OpenStreetMap data' : 'Select an area first'}
            onclick={() => selectTab('data')}
        >Data</button>
    </div>

    <!-- Menu button: opens/closes the right-hand drawer for the active tab's content. -->
    <button
        class="btn btn-square shadow-md border-0 absolute top-4 right-4 z-[1000] {menuOpen ? 'btn-primary' : 'bg-base-100'}"
        title={menuOpen ? 'Close menu' : 'Open menu'}
        aria-label="Toggle menu"
        onclick={() => menuOpen = !menuOpen}
    >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="4" y1="7" x2="20" y2="7"></line>
            <line x1="4" y1="12" x2="20" y2="12"></line>
            <line x1="4" y1="17" x2="20" y2="17"></line>
        </svg>
    </button>

    <!-- Live zoom readout (sits above the OL scale line at the bottom-left) -->
    <div class="absolute bottom-8 left-2 z-[1000] bg-base-100/90 shadow-md rounded px-2 py-0.5 text-xs font-mono tabular-nums pointer-events-none">
        z{mapZoom.toFixed(1)}
    </div>

    {#if canCollapse}
        <button class="collapse-btn btn btn-xs btn-circle bg-base-100 border-0 shadow" title="Hide map" onclick={onCollapse}>‹</button>
    {/if}

    <div class="menu-drawer absolute inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
        <!-- Title reflects the active panel tab; the tab itself is switched on the map. -->
        <div class="flex items-center bg-primary text-primary-content">
            <span class="flex-1 px-4 py-3 text-sm font-semibold">{activeTab === 'data' ? 'OSM data' : 'Map'}</span>
            <button class="btn btn-ghost btn-sm btn-circle text-primary-content self-center mx-1" aria-label="Close menu" onclick={() => menuOpen = false}>✕</button>
        </div>

        <!-- The Selection menu is unmounted when inactive (it only mirrors parent state), but the Data
             panel below stays MOUNTED and merely hidden — switching to the Selection tab to edit the
             area must not destroy its downloaded lists / per-feature state. -->
        {#if activeTab === 'selection'}
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

            {#if activeAttribution}
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Attribution</div>
                <Attribution attribution={activeAttribution} />
                <div class="mx-3 mb-2 text-xs opacity-70">
                    <a class="link link-primary" href="THIRD_PARTY_LICENSES.txt" target="_blank" rel="noopener noreferrer">Third-party software licenses</a>
                </div>
            {/if}
        </div>
        {/if}
        <div class="flex-1 flex flex-col min-h-0 {activeTab === 'data' ? '' : 'hidden'}">
            <OsmDataPanel
                bind:this={dataPanel}
                {features}
                {hasSelection}
                {selectionSide}
                active={menuOpen && activeTab === 'data'}
                onRequestOpen={() => { menuOpen = true; activeTab = 'data'; }}
                {onDownload}
                {onUpdatePreview}
                {onSaveJson}
                {onLoadJson}
                {onSelectElement}
                {onSetEnabled}
                {onDelete}
                {onHoverElement}
                {onMarksChange}
            />
        </div>
    </div>
</div>
