// Experiment only, applied to a throw-away clone: never part of the product.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const TS_QUERY = `
(function_declaration name: (identifier) @name) @def
(generator_function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(abstract_class_declaration name: (type_identifier) @name) @def
(interface_declaration name: (type_identifier) @name) @def
(type_alias_declaration name: (type_identifier) @name) @def
(enum_declaration name: (identifier) @name) @def
(internal_module name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(abstract_method_signature name: (property_identifier) @name) @def
(method_signature name: (property_identifier) @name) @def
(public_field_definition name: (property_identifier) @name value: [(arrow_function) (function_expression)]) @def
(program (lexical_declaration (variable_declarator name: (identifier) @name) @def))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def)))
(internal_module (statement_block (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @def))))
(function_signature name: (identifier) @name) @def
`;
const PY_QUERY = `
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
`;

interface Loaded {
  readonly ts: { parser: any; query: any };
  readonly py: { parser: any; query: any };
}
let loading: Promise<Loaded> | undefined;

function load(): Promise<Loaded> {
  loading ??= (async () => {
    const dir = process.env['MAO_TS_DIR'] ?? '';
    const require = createRequire(join(dir, 'x.js'));
    const { Parser, Language, Query } = require('web-tree-sitter');
    await Parser.init();
    const make = async (grammar: string, source: string) => {
      const language = await Language.load(
        join(dir, 'node_modules/tree-sitter-wasms/out', `tree-sitter-${grammar}.wasm`),
      );
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, query: new Query(language, source) };
    };
    return { ts: await make('typescript', TS_QUERY), py: await make('python', PY_QUERY) };
  })();
  return loading;
}

export interface Symbol {
  readonly name: string;
  readonly line: number;
  readonly end: number;
}

/** Undefined for a language it has no grammar for: the caller falls back to the regex. */
export async function symbolsOf(
  path: string,
  text: string,
): Promise<readonly Symbol[] | undefined> {
  const loaded = await load();
  const entry = path.endsWith('.ts') ? loaded.ts : path.endsWith('.py') ? loaded.py : undefined;
  if (entry === undefined) return undefined;
  const tree = entry.parser.parse(text);
  const found: Symbol[] = [];
  for (const match of entry.query.matches(tree.rootNode)) {
    const name = match.captures.find((c: any) => c.name === 'name')?.node;
    const def = match.captures.find((c: any) => c.name === 'def')?.node;
    if (name !== undefined && def !== undefined)
      found.push({
        name: name.text,
        line: name.startPosition.row + 1,
        end: def.endPosition.row + 1,
      });
  }
  tree.delete();
  return found;
}

export const arm = (): string => process.env['MAO_TS_ARM'] ?? 'regex';
