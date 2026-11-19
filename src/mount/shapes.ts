/**
 * Read-only SHACL shapes for the mounted reader (Acorn mount contract,
 * `mountShapes()` -> `{version, shapes: [{name, shape}]}`; same JSON shape
 * the Acorn language emits). No constructor, destructor, setter or writable
 * property: this slice exposes no write interactions.
 *
 * Property kinds: "ref" props are IRIs (DIDs); everything else lands as the
 * executor's deterministic literal. `createdAt` is a reserved model name,
 * hence `postCreatedAt` / `followCreatedAt`.
 */

export const SHAPES_VERSION = "1";

export const CLASS_NAMES = ["ATPost", "ATFollow", "ATAccount"] as const;
export type ClassName = (typeof CLASS_NAMES)[number];

interface Prop {
    name: string;
    ref?: boolean;
    collection?: boolean;
    alias?: Record<string, string>;
}

const RECORD_PROPS: Prop[] = [
    { name: "sourceUri" },
    { name: "cid" },
    { name: "atAuthor", ref: true },
    { name: "collection" },
    { name: "rkey" },
    { name: "verification" },
    { name: "sourceRecord" },
];

const CLASSES: Record<ClassName, Prop[]> = {
    ATPost: [
        { name: "text", alias: { TextContent: "text" } },
        { name: "postCreatedAt" },
        { name: "langs", collection: true },
        { name: "replyRootUri" },
        { name: "replyRootCid" },
        { name: "replyParentUri" },
        { name: "replyParentCid" },
        { name: "moderation" },
        { name: "labels" },
        { name: "activeLabels", collection: true },
        ...RECORD_PROPS,
    ],
    ATFollow: [
        { name: "subject", ref: true },
        { name: "followCreatedAt" },
        ...RECORD_PROPS,
    ],
    ATAccount: [
        { name: "did", ref: true },
        { name: "handle" },
        { name: "pds" },
        { name: "active" },
        { name: "status" },
        { name: "repoRev" },
        { name: "commitCid" },
    ],
};

const classIri = (name: ClassName) => `atproto://${name}`;

function propShape(p: Prop): Record<string, unknown> {
    const shape: Record<string, unknown> = { path: `atproto://${p.name}`, name: p.name };
    if (p.ref) {
        shape.node_kind = "IRI";
        shape.relation_kind = p.collection ? "hasMany" : "hasOne";
    }
    if (p.collection) shape.collection = true;
    else shape.max_count = 1;
    if (p.alias) shape.alias = p.alias;
    return shape;
}

export function mountShapes() {
    return {
        version: SHAPES_VERSION,
        shapes: CLASS_NAMES.map((name) => ({
            name,
            shape: {
                target_class: classIri(name),
                constructor_actions: [],
                destructor_actions: [],
                properties: [
                    { path: "rdf://type", name: "type", has_value: classIri(name), min_count: 1, max_count: 1 },
                    ...CLASSES[name].map(propShape),
                ],
            },
        })),
    };
}
