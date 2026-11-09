-- Earmark D-02/D-12: the guest role (agency staff). Its own migration: a new enum value cannot be used in the
-- transaction that adds it.
ALTER TYPE "Role" ADD VALUE 'guest';
