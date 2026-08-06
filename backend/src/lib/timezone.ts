// Every timestamp column in this schema is `timestamp without time zone`, so
// the value that lands in the database is whatever wall clock the Node process
// is running on. Production runs on EC2 in UTC; a laptop in Lagos does not.
// That difference showed up as receipts displaying an hour earlier than the
// driver typed, depending on which backend the dashboard was pointed at.
//
// Pinning the process to UTC makes writes and reads agree on every host. The
// dashboard already formats to Africa/Lagos for display, which is where the
// conversion belongs.
process.env.TZ = 'UTC';
