<script>
    import { untrack } from 'svelte';

    let {
        tileProviders = [],
        customMaps = [],
        initialActiveProviderId = '',
        initialSunDate = new Date(),
        initialShadows = true,
        onLayerSwitch = () => {},
        onSunChange = () => {},
        onShadowsChange = () => {},
        onSelectToggle = () => {},
        onSelectionSave = () => {},
    } = $props();

    let menuOpen = $state(false);
    let activeProviderId = $state(untrack(() => initialActiveProviderId));
    let providerList = $state(untrack(() => tileProviders));
    let customList = $state(untrack(() => customMaps));
    // Date + minutes-of-day kept separately so the time is a self-formatted 24h control
    // (datetime-local / time inputs render 12h or 24h per browser locale — unreliable).
    let dateValue = $state(untrack(() => toDateInput(initialSunDate)));
    let minutesOfDay = $state(untrack(() => initialSunDate.getHours() * 60 + initialSunDate.getMinutes()));

    let shadowsOn = $state(untrack(() => initialShadows));
    let selectActive = $state(false);
    let hasSelection = $state(false);

    // The Sun controls only make sense for sun-capable maps (e.g. hillshade).
    let sunEnabled = $derived(!!customList.find(c => c.id === activeProviderId)?.sun);
    let shadowsCapable = $derived(!!customList.find(c => c.id === activeProviderId)?.shadows);
    let timeLabel = $derived(formatTime(minutesOfDay));

    // Called by index.ts after the manifest loads / when the active map changes.
    export function setTileProviders(providers) { providerList = providers; }
    export function setCustomMaps(maps) { customList = maps; }
    export function setActiveProvider(id) { activeProviderId = id; }
    export function setSelectActive(active) { selectActive = active; }
    export function setHasSelection(has) { hasSelection = has; }

    function toggleSelect() {
        selectActive = !selectActive;
        if (!selectActive) hasSelection = false;
        onSelectToggle(selectActive);
    }

    function handleLayerSwitch(id) {
        if (id === activeProviderId) return;
        activeProviderId = id;
        menuOpen = false;
        onLayerSwitch(id);
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    // Format a Date as the local 'YYYY-MM-DD' string a date input needs.
    function toDateInput(date) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    // Always 24h, formatted by us — independent of browser locale.
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

<!-- Selection toolbar (top-left) -->
<div class="fixed top-4 left-4 z-[1000] flex flex-col gap-2">
    <button
        class="btn btn-square shadow-md border-0 {selectActive ? 'btn-primary' : 'bg-base-100'}"
        aria-label="Select area"
        title="Select area"
        onclick={toggleSelect}
    >⬚</button>
    {#if selectActive && hasSelection}
        <button
            class="btn btn-square bg-base-100 shadow-md border-0"
            aria-label="Save selection"
            title="Save selection"
            onclick={onSelectionSave}
        >💾</button>
    {/if}
</div>

<!-- Menu button (top-right, above map) -->
<button
    class="btn btn-square bg-base-100 shadow-md fixed top-4 right-4 z-[1000] border-0"
    aria-label="Open menu"
    onclick={() => menuOpen = true}
>
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"></line>
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
    </svg>
</button>

{#if menuOpen}
    <button class="fixed inset-0 z-[1999] cursor-default bg-transparent border-0 p-0" aria-label="Close menu" onclick={() => menuOpen = false}></button>
{/if}

<div class="fixed inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
    <div class="flex items-center justify-between px-4 py-3 bg-primary text-primary-content">
        <h2 class="text-lg font-semibold">Map Controls</h2>
        <button class="btn btn-ghost btn-sm btn-circle text-primary-content" onclick={() => menuOpen = false}>✕</button>
    </div>
    <div class="overflow-y-auto flex-1 py-2">
        <div class="px-4 py-1 text-xs font-bold uppercase tracking-wider opacity-50">Map Source</div>
        <ul class="menu px-2">
            {#each providerList as provider (provider.id)}
                <li>
                    <button
                        class={provider.id === activeProviderId ? 'active' : ''}
                        onclick={() => handleLayerSwitch(provider.id)}
                    >
                        <span>{provider.icon}</span>
                        {provider.name}
                    </button>
                </li>
            {/each}
        </ul>

        {#if customList.length}
            <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Custom Maps</div>
            <ul class="menu px-2">
                {#each customList as custom (custom.id)}
                    <li>
                        <button
                            class={custom.id === activeProviderId ? 'active' : ''}
                            onclick={() => handleLayerSwitch(custom.id)}
                        >
                            <span>{custom.icon}</span>
                            {custom.name}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}

        {#if sunEnabled}
            <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Sun</div>
            <div class="px-4 py-2 flex flex-col gap-2">
                <input
                    type="date"
                    class="input input-sm input-bordered w-full"
                    bind:value={dateValue}
                    onchange={emitSun}
                />
                <div class="flex items-center gap-2">
                    <input
                        type="range"
                        min="0"
                        max="1439"
                        step="5"
                        class="range range-sm flex-1"
                        bind:value={minutesOfDay}
                        oninput={emitSun}
                    />
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
