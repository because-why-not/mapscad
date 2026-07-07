// @vitest-environment jsdom
// TrackParser turns GPX/TCX XML into id-less `{ name, coords }` tracks (lon/lat polylines) that the
// OSM Load flow ingests like a saved feature file. jsdom provides the DOMParser the parser relies on.
import { describe, it, expect } from 'vitest';
import { parseTrackFile, isTrackFile } from '../../src/kit/mapelements/TrackParser';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Morning Hike</name>
    <trkseg>
      <trkpt lat="47.30" lon="8.50"><ele>500</ele></trkpt>
      <trkpt lat="47.31" lon="8.51"></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="47.40" lon="8.60"></trkpt>
      <trkpt lat="47.41" lon="8.61"></trkpt>
    </trkseg>
  </trk>
  <rte>
    <name>Planned Route</name>
    <rtept lat="47.10" lon="8.20"></rtept>
    <rtept lat="47.11" lon="8.21"></rtept>
  </rte>
  <wpt lat="47.00" lon="8.00"><name>Lone Waypoint</name></wpt>
</gpx>`;

const TCX = `<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Courses>
    <Course>
      <Name>Race Course</Name>
      <Track>
        <Trackpoint>
          <Position><LatitudeDegrees>47.30</LatitudeDegrees><LongitudeDegrees>8.50</LongitudeDegrees></Position>
        </Trackpoint>
        <Trackpoint>
          <!-- no Position: paused/indoor sample, skipped -->
        </Trackpoint>
        <Trackpoint>
          <Position><LatitudeDegrees>47.31</LatitudeDegrees><LongitudeDegrees>8.51</LongitudeDegrees></Position>
        </Trackpoint>
      </Track>
    </Course>
  </Courses>
</TrainingCenterDatabase>`;

describe('TrackParser', () => {
    it('parses GPX track segments and routes as [lon, lat] polylines', () => {
        const tracks = parseTrackFile(GPX, 'hike.gpx');
        // two trksegs + one rte = three polylines; the lone waypoint is not a line, so dropped.
        expect(tracks).toHaveLength(3);
        expect(tracks[0]).toEqual({ name: 'Morning Hike', coords: [[8.50, 47.30], [8.51, 47.31]] });
        expect(tracks[1]).toEqual({ name: 'Morning Hike', coords: [[8.60, 47.40], [8.61, 47.41]] });
        expect(tracks[2].name).toBe('Planned Route');
    });

    it('parses TCX tracks and skips trackpoints without a Position', () => {
        const tracks = parseTrackFile(TCX, 'race.tcx');
        expect(tracks).toHaveLength(1);
        expect(tracks[0]).toEqual({ name: 'Race Course', coords: [[8.50, 47.30], [8.51, 47.31]] });
    });

    it('detects the format from the XML root when the extension is unknown', () => {
        expect(parseTrackFile(GPX, 'noext')).toHaveLength(3);
        expect(parseTrackFile(TCX, 'noext')).toHaveLength(1);
    });

    it('throws on invalid XML and unrecognised formats', () => {
        expect(() => parseTrackFile('not xml at all', 'x.gpx')).toThrow();
        expect(() => parseTrackFile('<html><body/></html>', 'x.kml')).toThrow(/Unsupported/);
    });

    it('recognises track filenames case-insensitively', () => {
        expect(isTrackFile('a.GPX')).toBe(true);
        expect(isTrackFile('b.tcx')).toBe(true);
        expect(isTrackFile('c.json')).toBe(false);
    });
});
