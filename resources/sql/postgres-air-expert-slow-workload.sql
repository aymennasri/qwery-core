-- Expert-level slow-query workload for postgres_air.
--
-- These statements are intentionally inefficient for reasons that go beyond
-- a missing single-column index. They combine correlated subqueries, fan-out
-- joins with DISTINCT aggregates, materialized CTEs, large window sorts, late
-- filtering, and non-sargable time predicates so the optimizer agent has
-- realistic hard cases to analyze.

SET statement_timeout = '15min';

-- 1. Correlated passenger performance profile.
-- Repeats large scans of boarding_pass and booking_leg for each outer row.
SELECT
  p.passenger_id,
  (
    SELECT count(*)
    FROM postgres_air.boarding_pass bp
    JOIN postgres_air.booking_leg bl
      ON bl.booking_leg_id = bp.booking_leg_id
    JOIN postgres_air.flight f
      ON f.flight_id = bl.flight_id
    WHERE bp.passenger_id = p.passenger_id
      AND f.actual_departure BETWEEN TIMESTAMPTZ '2024-06-01'
      AND TIMESTAMPTZ '2024-08-31'
  ) AS summer_boardings,
  (
    SELECT count(DISTINCT bl.flight_id)
    FROM postgres_air.booking_leg bl
    JOIN postgres_air.flight f
      ON f.flight_id = bl.flight_id
    WHERE bl.booking_id = p.booking_id
      AND f.status IN ('On Time', 'Delayed')
  ) AS active_itinerary_legs,
  (
    SELECT avg(EXTRACT(EPOCH FROM (f.actual_arrival - f.scheduled_arrival)))
    FROM postgres_air.boarding_pass bp
    JOIN postgres_air.booking_leg bl
      ON bl.booking_leg_id = bp.booking_leg_id
    JOIN postgres_air.flight f
      ON f.flight_id = bl.flight_id
    WHERE bp.passenger_id = p.passenger_id
      AND f.actual_arrival IS NOT NULL
  ) AS avg_arrival_delay_seconds
FROM postgres_air.passenger p
WHERE p.booking_id % 5000009 = 0
ORDER BY summer_boardings DESC NULLS LAST,
         avg_arrival_delay_seconds DESC NULLS LAST
LIMIT 200;

-- 2. Booking/account rollup with fan-out distortion.
-- Multiplies booking, passenger, booking_leg, and phone rows together, then
-- pays for DISTINCT aggregates and temp-spilling sorts to recover correctness.
SELECT
  b.account_id,
  count(DISTINCT b.booking_id) AS bookings,
  count(DISTINCT p.passenger_id) AS passengers,
  count(DISTINCT bl.booking_leg_id) AS legs,
  sum(b.price) AS revenue,
  string_agg(DISTINCT ph.phone_type, ',' ORDER BY ph.phone_type) AS phone_types
FROM postgres_air.booking b
JOIN postgres_air.passenger p
  ON p.booking_id = b.booking_id
JOIN postgres_air.booking_leg bl
  ON bl.booking_id = b.booking_id
LEFT JOIN postgres_air.phone ph
  ON ph.account_id = b.account_id
WHERE date_trunc('month', b.update_ts) BETWEEN date_trunc('month', TIMESTAMPTZ '2024-06-01')
                                           AND date_trunc('month', TIMESTAMPTZ '2024-09-01')
GROUP BY b.account_id
HAVING count(DISTINCT bl.booking_leg_id) > 5
ORDER BY revenue DESC
LIMIT 200;

-- 3. Passenger connection-gap analysis with materialized CTE and window churn.
-- Sorts and windows over a very large passenger-leg stream before late-stage
-- grouping and percentile calculation.
WITH leg_chain AS MATERIALIZED (
  SELECT
    p.passenger_id,
    bl.booking_id,
    bl.leg_num,
    f.departure_airport,
    f.arrival_airport,
    f.scheduled_departure,
    f.actual_departure,
    f.actual_arrival,
    lead(f.scheduled_departure) OVER (
      PARTITION BY p.passenger_id
      ORDER BY f.scheduled_departure, bl.leg_num
    ) AS next_departure,
    lag(f.actual_arrival) OVER (
      PARTITION BY p.passenger_id
      ORDER BY f.scheduled_departure, bl.leg_num
    ) AS prev_arrival
  FROM postgres_air.passenger p
  JOIN postgres_air.booking_leg bl
    ON bl.booking_id = p.booking_id
  JOIN postgres_air.flight f
    ON f.flight_id = bl.flight_id
  WHERE f.scheduled_departure BETWEEN TIMESTAMPTZ '2024-06-01'
                                  AND TIMESTAMPTZ '2024-07-31'
)
SELECT
  departure_airport,
  arrival_airport,
  count(*) FILTER (
    WHERE next_departure IS NOT NULL
      AND next_departure - actual_arrival < INTERVAL '45 minutes'
  ) AS tight_connections,
  percentile_disc(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (next_departure - actual_arrival))
  ) AS p95_connection_gap_seconds
FROM leg_chain
WHERE prev_arrival IS NOT NULL
GROUP BY departure_airport, arrival_airport
ORDER BY tight_connections DESC, p95_connection_gap_seconds
LIMIT 50;
