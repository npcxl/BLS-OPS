/**
 * English overrides for keys that are written in Chinese.
 *
 * Most `t()` calls already use English natural keys (the key *is* the text),
 * so they need no entry here. Only the database workbench still calls `t()`
 * with Chinese strings — those would otherwise leak Chinese into the English
 * UI. Anything not listed falls back to the key itself.
 */
import commands from "./commands";
import database from "./database";
import databaseErrors from "./databaseErrors";
import databaseUi from "./databaseUi";
import databaseWorkspace from "./databaseWorkspace";
import dbEngines from "./dbEngines";
import redis from "./redis";
import workbenchUi from "./workbenchUi";

export default {
  ...commands,
  ...database,
  ...databaseWorkspace,
  ...databaseUi,
  ...databaseErrors,
  ...dbEngines,
  ...redis,
  ...workbenchUi,
} as const;
