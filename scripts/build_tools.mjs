// Developer script: writes mcp/tools.json from vocab.js. Run: node scripts/build_tools.mjs
// The Ruby server cannot read vocab.js, so the tool list lives in a file; tests/tools.test.mjs fails when the two differ.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadContext, ROOT } from "./load_scripts.mjs";

const OBSERVE = "The person sees exactly these steps and must click Allow. If they say no, do not ask again for the same thing unless they ask you to.";

export function buildTools(V) {
  const kinds = Object.keys(V.STEP_SPECS);
  const props = {};
  const addProp = (name, def) => { if (!props[name]) props[name] = def; };
  props.do = { type: "string", enum: kinds, description: "The kind of step." };
  const whats = [];
  for (const kind of kinds) {
    const fields = V.STEP_SPECS[kind].fields;
    for (const name of Object.keys(fields)) {
      const f = fields[name];
      if (name === "what") {
        for (const v of f.values) if (!whats.includes(v)) whats.push(v);
        continue;
      }
      if (f.kind === "int") addProp(name, { type: "integer", minimum: f.min, maximum: f.max, description: f.desc });
      else if (f.kind === "bool") addProp(name, { type: "boolean", description: f.desc });
      else if (f.kind === "enum") addProp(name, { type: "string", enum: f.values.slice(), description: f.desc });
      else if (f.kind === "folder") addProp(name, { type: "string", maxLength: 270, pattern: V.FOLDER_RE.source, description: f.desc });
    }
  }
  props.what = { type: "string", enum: whats, description: "What to do. For window: " + V.STEP_SPECS.window.fields.what.values.join(", ") + ". For desktop: " + V.STEP_SPECS.desktop.fields.what.values.join(", ") + ". For system: " + V.STEP_SPECS.system.fields.what.values.join(", ") + "." };

  const lines = kinds.map((kind) => {
    const spec = V.STEP_SPECS[kind];
    const names = Object.keys(spec.fields);
    const fieldText = names.length === 0 ? "no other fields" : names.map((n) => n + (spec.required.includes(n) ? " (required)" : " (optional)")).join(", ");
    return "- " + kind + ": " + spec.summary + " Fields: " + fieldText + ".";
  });

  const proposeDescription = [
    "Ask to run desktop steps on this computer: switch workspaces, open apps from a fixed list, and arrange windows.",
    OBSERVE,
    "A request has 1 to 12 steps. The apps are: " + V.APP_LIST_TEXT + ". Nothing else can be requested: no commands, no web addresses, no free text, no screenshots.",
    "The answer says what the person decided and how each step went. If the steps are still running after about 50 seconds, call desk_plan_result with the id it gives.",
    "Each step is an object with \"do\" and its fields:",
    ...lines
  ].join("\n");

  return {
    tools: [
      {
        name: "propose_desk_plan",
        description: proposeDescription,
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              maxItems: V.LIMITS.maxSteps,
              description: "The steps, in order.",
              items: { type: "object", properties: props, required: ["do"], additionalProperties: false }
            }
          },
          required: ["steps"],
          additionalProperties: false
        }
      },
      {
        name: "desk_plan_result",
        description: "Collect the result of a request from propose_desk_plan that was still running. Give the id it returned. Waits up to 20 seconds. " + OBSERVE,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", pattern: "^[0-9a-f]{32}$", description: "The id from propose_desk_plan." } },
          required: ["id"],
          additionalProperties: false
        }
      },
      {
        name: "desk_state",
        description: "See the active workspace, and which apps from the list are open on which workspace. It never includes window titles, addresses or pictures. It can be asked about once a second.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    ]
  };
}

export function toolsText(V) {
  return JSON.stringify(buildTools(V), null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const V = loadContext().VocabApi;
  const file = path.join(ROOT, "mcp", "tools.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toolsText(V));
  console.log("wrote " + path.relative(ROOT, file));
}
