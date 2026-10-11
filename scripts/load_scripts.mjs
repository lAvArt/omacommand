// Loads vocab.js and box_model.js exactly as they are on disk. QML imports the same bytes, so what the tests and the tools
// script see is what the shell runs.
//
// QML gives each imported script file its own scope (`import "vocab.js" as Vocab`, `import "box_model.js" as BoxModel`): the
// model cannot see a global of the vocabulary. So the two are loaded into two separate vm contexts here, and the model only
// gets the vocabulary the way Service.qml gives it: as an argument to createDesk (review C16).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadFile(file, extra) {
  const ctx = vm.createContext(Object.assign({}, extra || {}));
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx, { filename: file });
  return ctx;
}

// The context of vocab.js alone (VocabApi).
export function loadContext(extra) {
  return loadFile("vocab.js", extra);
}

// The two contexts, each with only its own file: { vocab, model }. model.ModelApi.createDesk(vocab.VocabApi, ports).
export function loadContexts() {
  return { vocab: loadFile("vocab.js"), model: loadFile("box_model.js") };
}
