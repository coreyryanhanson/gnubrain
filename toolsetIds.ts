// The two toolset identifiers — shared vocabulary owned once, not across
// the read and write tool modules (write requires read, but the IDs are
// not read-module behavior).

export const READ_TOOLSET_ID = "gnubrain.read";
export const WRITE_TOOLSET_ID = "gnubrain.write";
