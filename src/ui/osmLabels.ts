/** UI-only display strings for each OSM feature, keyed by feature id. Kept out of the kit's
 *  `OsmFeatureDef` so the data/model layer carries no menu text — a different UI could label
 *  these differently. `label` = section heading; `noun` = plural for button feedback ("12 tracks").
 *  Shared by `OsmDataPanel` and `PreviewPanel`. */
export const OSM_LABELS: Record<string, { label: string; noun: string }> = {
    buildings: { label: 'Buildings', noun: 'buildings' },
    streets: { label: 'Streets', noun: 'streets' },
    tracks: { label: 'Tracks', noun: 'tracks' },
};
