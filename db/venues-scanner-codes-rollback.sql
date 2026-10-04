-- Undo db/venues-scanner-codes.sql. Signs out every scanner device and deletes all scanner codes.
drop table if exists public.scanner_devices;
drop table if exists public.scanner_codes;
