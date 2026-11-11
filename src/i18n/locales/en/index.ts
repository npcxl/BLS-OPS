/**
 * English overrides for keys that are written in Chinese.
 *
 * Most `t()` calls already use English natural keys (the key *is* the text),
 * so they need no entry here. Only the database workbench still calls `t()`
 * with Chinese strings — those would otherwise leak Chinese into the English
 * UI. Anything not listed falls back to the key itself.
 */
import database from "./database";
import databaseWorkspace from "./databaseWorkspace";

export default {
  ...database,
  ...databaseWorkspace,
} as const;
