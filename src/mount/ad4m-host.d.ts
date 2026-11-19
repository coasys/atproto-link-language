// The executor's host module, imported as a namespace by mount-index.ts so
// that a function an older executor lacks (writeStorageFileAtomic) is
// simply absent — a named import would fail to link and stop the language.
declare module "ad4m:host";
