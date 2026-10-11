# Rail Planning

## Demand And Pull

Consumers request ingredients rather than producers continuously pushing everything they could produce. For a target output rate, the planner expands the selected recipes and sums the required deliveries to every consumer. Rounded machine counts do not imply that every installed machine produces at full capacity.

References reviewed on 2026-10-03:

- [Community Rail & Transport Guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3645384098): consumer requests, mixed-item shared rails, demand, and reported v1/v2/v3 capacities.
- [Creepy Jar's Base Building Basics, Part 2](https://steamcommunity.com/ogg/1631270/announcements/detail/673998750553735384): Drone Smart Path, drone priority, and rail upgrading.
- [Community bypass discussion](https://steamcommunity.com/app/1631270/discussions/0/796713775850948156/): retaining access to upstream products around processing buildings.

Community observations are not an authoritative specification of route choice or timing. Pull behavior does not remove congestion or guarantee automatic load balancing.

## Physical Route Assumption

The graph represents the intended physical shared-rail layout. Every ingredient demand is routed from the producer's output branch to its column's collection spine, then to the consumer's delivery spine and input branch. Connections between adjacent columns use the main horizontal route. Connections skipping columns use the common top bypass. Traffic joins or leaves at its actual branch points.

Overlapping routes are split at endpoints into atomic segments. Their loads are summed per segment, across all materials. A shared segment does not carry every product in the entire factory: it carries only the demands whose drawn routes traverse it. Intermediate traffic is counted again when it traverses another physical segment, not as additional production demand. Final product output is accounted for in the planner and final-node tooltip without drawing an extra rail beyond the final node. Small junction circles mark rail joins and bypass corners.

Tier changes can add ingredients and change the network, so the routes and recommendations are rebuilt alongside the production chain. Chain expansion orders consumers before inputs using the selected recipes, ensuring later consumers cannot be lost from shared ingredient demand.

## Auto And Manual

- Auto uses the lowest-capacity tier at or below the selected highest-unlocked rail tier that can carry the segment's average demand. If demand exceeds the unlocked tier, Auto reports the theoretical minimum number of parallel rails at that tier; it never assumes later-game rails are available.
- Manual applies the selected tier and reports `ceil(segment demand / tier capacity)` for each segment.
- New setups start in Auto with v1 selected as the conservative unlocked-tier default. In Auto, the rail selector is the maximum available tier; in Manual, it is the exact tier applied. The existing `rail` share parameter stores either meaning according to `railMode`. Old links containing `rail` but no `railMode` retain Manual behavior. Mode changes at the top wait for Calculate; machine tier toggles update the displayed plan immediately.
- Input-node count is sized per machine: sum all recipe input rates, divide by the installed machine count represented in the node, and add input nodes if that per-machine aggregate exceeds the selected rail capacity. Different requested items can share each input rail under the pull system. Separately, each shared route segment is sized from its total aggregate traffic before it reaches machines; e.g. a machine group's trunk can require multiple v5 rails even when each machine needs only one v2 input node. The Roundabout's speed rule does not by itself prove that it balances or distributes load among machines.
- Vertical rail spans have individual labels centered between their junctions, beside their own input or output spine. Horizontal contiguous spans can share a label only while their recommendation and carried-item set match. Labels avoid node shapes and other labels; short machine-to-spine connector stubs intentionally remain blank. Every segment retains its own rate, material breakdown, and recommendation in its tooltip, including spans where an inline label cannot fit.
- Simple graph mode keeps one node per product group. Complex graph mode expands installed machines into individual nodes and distributes each ingredient through a shared producer pool. This symmetric pooled-feed view avoids inventing one-to-one machine pairings; it is not a claim about physical in-game routing. Aggregate shared-segment capacity calculations are preserved. White junctions represent the standard Rail Connector, including intended three-direction joins. Complex mode marks a Modulator candidate only when adjacent segments recommend different parallel-rail counts; these are layout suggestions, not verified throughput guarantees. Before expansion, work is estimated as eight units per machine/source node plus six units per projected aggregated route leg. Each group connection projects two branches per producer, one trunk, and two branches per consumer, plus final output legs. Complex mode retains the 30,000 work-unit budget and grouped fallback; the estimate is a heuristic, not a guaranteed time or memory bound.

Configured capacities are 120, 240, 480, 750, and 1500 items/minute, matching the descriptions verified directly on starrupture.tools on 2026-10-03: [v1](https://starrupture.tools/buildings/drone-rail-t1), [v2](https://starrupture.tools/buildings/drone-rail-t2), [v3](https://starrupture.tools/buildings/drone-rail-t3), [v4](https://starrupture.tools/buildings/drone-rail-t4), and [v5](https://starrupture.tools/buildings/drone-rail-t5). These database entries are the capacity source of truth; the earlier community-table uncertainty is resolved. The centralized `RAIL_TIERS` list contains those values.

## Rail Hardware Model

Rail capacity and connector topology are separate concerns. The current metadata records the official Update 2 Roundabout rule: it does not add capacity and moves drones at the speed of the fastest connected rail. The [official Update 2 notes](https://steamcommunity.com/ogg/1631270/announcements/detail/699896983612034030) describe this as the Drone Roundabout overhaul.

The [Rail Connector database entry](https://starrupture.tools/buildings/drone-junction-4) describes a Drone Rail connection that allows paths to split and expand. It is the default for ordinary graph junctions. The [transport building database](https://starrupture.tools/buildings/transport) describes Rail Modulators as handling rail-count changes and Multirail 3/5 as supporting parallel rails. Modulator placement remains an advisory topology estimate; merger throughput and machine socket limits are not modeled. The community [Rail & Transport Guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3645384098) warns that connector/merger throughput can be a concern, so no throughput multiplier is assumed. `2x2` building footprint labels are intentionally excluded from rail capacity and connection planning.

Raw materials are represented as source nodes, not production machines. Item flows remain individually attributable, and multiple items can share physical rail under the pull system: overlapping routes sum for that segment's capacity recommendation while retaining per-item rates in its flow breakdown. Machine-level connections and connector placement are visualized in Complex mode, with structure suggestions remaining advisory.

Single-machine product groups omit the visible `#1` suffix; multi-machine groups retain instance numbers. Selection highlights the chosen node, its direct suppliers, and shared route segments carrying deliveries to it. In Complex mode, identical consumer instances highlight the same pooled supplier set, though their route branches can differ. Graph detail is retained within the current page session but is not encoded in share links.

The current Modulator selector supports recommendations up to five rails. A transition involving more than five rails has no Modulator candidate; the planner does not infer a multi-Modulator arrangement. Multirail hints likewise require checking support grouping in-game and must not be interpreted as one structure supporting arbitrarily many rails. Ordinary joins do not become Modulator candidates merely because three directions meet.

These are steady-state planning estimates. Bursty requests, buffer startup, route priorities, travel time, junction contention, item sizes, and dynamic rerouting are not simulated. Parallel counts are a capacity lower bound, not a guarantee that the game divides traffic evenly. Actual factories may need additional capacity or deliberately separated routes.

## Tests

`npm test` covers tier boundaries, fractional thresholds, parallel counts, bypass join/leave loads, every recipe in v1/v2/mixed tiers, production-demand conservation, final outputs, per-segment capacity, rail-mode persistence, graph detail switching, symmetric pooled feeds, work-cost estimation, live tier changes, mobile interactions, graph fitting, and label grouping/spacing/bounds. Carbon Sonar regressions check vertical label midpoint and horizontal attachment to the correct rail.

## Aggregated Routing

Complex rendering uses `expandPooledMachineGraph` and `buildAggregatedRailSegments`. Expansion retains grouped recipe links instead of allocating every producer-consumer machine pair. Routing accepts positioned machine instances and grouped recipe demands, generating producer branches, one trunk per group connection, and consumer branches. Groups must share a column and depth. The pairwise builder remains a test reference; both builders use the same atomic-segment splitter. Supplier-pool membership drives node highlights separately from route consumer attribution. First-encounter lane order is preserved to keep segment IDs and label ordering stable.

`aggregated-routing.test.mjs` compares geometry, per-item rates, consumer sets, direction flags, and capacity recommendations with the current pairwise builder. Synthetic cases include raw sources, multiple consumers, bypasses, fractional demand, and capacity boundaries. Browser-backed comparisons exercise real recipes in v1 and v2, skipping reference plans above 180,000 pairwise links to bound test cost.

Floating-point accumulation can differ: repeated pairwise additions may move exact capacity-boundary demand slightly above a threshold. Rail recommendations tolerate drift up to `1e-12 * max(1, demand)` items/min at capacity boundaries. This is one part in a trillion for demand above one item/min; meaningful excess demand still requires additional capacity. Differential tests require zero recommendation mismatches across the real-plan comparisons, equal segment enumeration order, and flow agreement within numeric tolerance. App-level tests also prohibit pairwise expansion calls and verify labels, supplier highlighting, and oversized-plan fallback.

Initial route-only Chromium timings on Carbon Sonar at 60/min were approximately 3,919 ms pairwise versus 457 ms aggregated for v1, and 99 ms versus 18 ms for v2. These are development measurements, not guaranteed speedups, and exclude expansion and SVG rendering. A forced desktop render of the 595-machine all-v2 plan took about 289 ms, but its estimated 38,710 work units still exceed the retained budget. The budget has not been raised from a single desktop measurement. These integration changes are local until separately reviewed and published.