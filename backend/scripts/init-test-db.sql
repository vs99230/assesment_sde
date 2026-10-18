-- Runs once, when the database volume is first created.
-- A separate database for the test suite, so tests can wipe it freely.
CREATE DATABASE ops_test OWNER ops;
