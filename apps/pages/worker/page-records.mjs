// PageRecords: a Durable Object class that is declared and bound, and that
// nothing calls. Its `v2` `new_sqlite_classes` migration tag registered it,
// and a deployed target that still binds it needs the class to exist. Removing
// the class, its binding and this module takes a `deleted_classes` migration,
// which celld 0.6.3 refuses (DEPLOYMENT.md: Old PageRecords objects). Any
// records an object still holds stay where they are; no code reads them.
export class PageRecords {}
