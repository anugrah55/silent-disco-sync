Simulated with 20 clients per scenario, 60 s each, seed 42 (`npm run sim -- --all`).

| Scenario    | One-way latency | Asymmetry | Queueing (mean, % uplink) | Offset error median | p90      | p99      | Naive mean, median | Spread (max-min) median | Start error median | p90      | max      | Late arrivals | Within rtt/2 bound |
| ----------- | --------------- | --------- | ------------------------- | ------------------- | -------- | -------- | ------------------ | ----------------------- | ------------------ | -------- | -------- | ------------- | ------------------ |
| **lan**     | 1-4 ms          | ±0.5 ms   | 0.2-2 ms, 50%             | 0.27 ms             | 0.70 ms  | 1.15 ms  | 0.24 ms            | 1.65 ms                 | 0.27 ms            | 0.74 ms  | 1.28 ms  | 0/100         | 100.0%             |
| **wifi**    | 10-40 ms        | ±4 ms     | 1-10 ms, 60%              | 1.32 ms             | 2.60 ms  | 4.28 ms  | 1.79 ms            | 6.48 ms                 | 1.39 ms            | 2.69 ms  | 4.73 ms  | 0/100         | 100.0%             |
| **mobile**  | 30-90 ms        | ±10 ms    | 5-30 ms, 75%              | 2.80 ms             | 6.38 ms  | 8.62 ms  | 8.83 ms            | 14.30 ms                | 2.77 ms            | 6.58 ms  | 8.79 ms  | 0/100         | 100.0%             |
| **hostile** | 50-150 ms       | ±30 ms    | 20-60 ms, 85%             | 7.82 ms             | 20.05 ms | 26.95 ms | 28.25 ms           | 42.88 ms                | 8.00 ms            | 20.98 ms | 27.36 ms | 0/100         | 100.0%             |

- **lan** (Same Wi-Fi as a local server): 5 scheduled plays, lead time 1500 ms / 1500 ms / 1500 ms / 1500 ms / 1500 ms; actual error / estimated error median 0.38.
- **wifi** (Home Wi-Fi to a nearby cloud region): 5 scheduled plays, lead time 1500 ms / 1500 ms / 1500 ms / 1500 ms / 1500 ms; actual error / estimated error median 0.83.
- **mobile** (4G/5G phones, busy cell): 5 scheduled plays, lead time 1500 ms / 1500 ms / 1500 ms / 2118 ms / 1500 ms; actual error / estimated error median 0.66.
- **hostile** (Congested uplinks, big one-sided delay): 5 scheduled plays, lead time 2548 ms / 2588 ms / 3117 ms / 2874 ms / 2874 ms; actual error / estimated error median 1.03.
