# Route comparison (pace-18)

- Uses FOSSGIS's separately prepared `routed-foot` OSRM endpoint, never the driving service.
- Requests `alternatives=true` in one request; keeps up to three distinct valid provider routes. Alternatives are not guaranteed; a single returned route remains one route.
- Ranks returned candidates by full distance / the chosen calibrated or configured pace. This is departure-point planning, not live remaining ETA. Signals, grades and obstacles are excluded. The shortest returned candidate is not claimed to be the shortest of every possible path.
- Map shows gray alternatives and blue selected route. Main ETA continues using recent GPS when tracking, chosen pace otherwise.
- Optional Overpass query returns actual OSM `highway=street_lamp` nodes within a bounded region (diagonal <=5km). Counts nodes within 20m of each candidate; shared/parallel roads and missing mapping can bias counts. No brightness, light operation or safety inference, ranking or recommendation is made. Zero nodes is unknown, not dark.
- Exact-route coordinates go to FOSSGIS only after consent. Lamp query bounding region goes to Overpass only after separate consent. External server logging policies apply.
- Bus+walk transit routing is NOT connected. TAGO arrivals/nearby stops alone do not provide multimodal route search. An authorized provider account/key (e.g. ODsay) and server integration remain required. No fabricated bus path, travel time or fare is displayed.

Official references checked 2026-11-13:
- https://routing.openstreetmap.de/about.html (OSRM, transport-specific servers, max 1 request/second, logging)
- https://project-osrm.org/docs/v5.24.0/api/ (route alternatives, no guarantee)
- https://wiki.openstreetmap.org/wiki/Key:lit
- https://wiki.openstreetmap.org/wiki/Tag:highway%3Dstreet_lamp
- https://lab.odsay.com/guide/releaseReference?platform=web (transit routing, required apiKey)

Tests include malformed/duplicate route responses, single result, lamp filtering, bounded areas, partial responses, explicit consent/cancel, changed destination during pending request, and UI route selection. Real iPhone field testing is separate.
