// The only code that talks to anfra (POST /api/core.<op>, shapes from `anfra openapi`).
// It only ever sends AQL from anfra-user.yml or a page file: never SQL, never AQL from a request.

export type AnfraFilter = { field: string; operator: string; values: string[]; modifier?: string; aggregation?: string };
export type AnfraDateDrill = { field: string; grain: string };
export type AnfraSort = { field: string; direction: 'asc' | 'desc' };

export type Column = { name: string; label: string; semantic_type?: string; isMeasure?: boolean; field?: string };
export type QueryResult = { columns: Column[]; rows: Record<string, unknown>[]; hasMore: boolean };

export class AnfraError extends Error {
  name = 'AnfraError';
  code: string;
  constructor(message: string, code = 'anfra_error') {
    super(message);
    this.code = code;
  }
}

async function call(baseUrl: string, op: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/core.${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AnfraError(`Can't reach anfra at ${baseUrl}: is \`anfra serve\` running? (${(err as Error).message})`, 'anfra_unreachable');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AnfraError(json?.error?.message ?? `anfra answered ${res.status}`, json?.error?.code);
  return json;
}

export async function runQuery(
  baseUrl: string,
  req: {
    dataset: string; aql: string; filters?: AnfraFilter[]; sorts?: AnfraSort[]; dateDrills?: AnfraDateDrill[];
    page?: number; pageSize?: number; timezone?: string;
  },
): Promise<QueryResult> {
  const input: Record<string, unknown> = {};
  if (req.filters?.length) input.filters = req.filters;
  if (req.sorts?.length) input.sorts = req.sorts;
  if (req.dateDrills?.length) input.dateDrills = req.dateDrills;
  const body: Record<string, unknown> = { lang: 'aql', dataset: req.dataset, query: req.aql };
  if (Object.keys(input).length) body.input = input;
  if (req.timezone) body.timezone = req.timezone;
  if (req.pageSize) {
    body.page_size = req.pageSize;
    body.page = req.page ?? 1;
  }
  const json = await call(baseUrl, 'query', body);
  const fields: string[] = json.result.fields;
  return {
    // Only what a page needs: no SQL, no executed AQL, no database types.
    columns: json.columns.map((c: any) => ({
      name: c.name, label: c.label, semantic_type: c.semantic_type, isMeasure: c.isMeasure,
      // A dimension's model.field, so a page can turn a selected row into filters (cross-filtering).
      ...(!c.isMeasure && c.modelId && c.fieldName ? { field: `${c.modelId}.${c.fieldName}` } : {}),
    })),
    rows: json.result.records.map((r: unknown[]) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))),
    hasMore: Boolean(json.has_more),
  };
}

export async function validateQuery(baseUrl: string, dataset: string, aql: string): Promise<string[]> {
  const json = await call(baseUrl, 'query.validate', { lang: 'aql', dataset, query: aql });
  const diagnostics: any[] = json.diagnostics ?? json.result?.diagnostics ?? [];
  return diagnostics.filter((d) => (d.severity ?? 'error') === 'error').map((d) => d.message);
}

// The SDK's Anfra.datasets[fqn] shape, for pages written against the Anfra SDK.
export type DatasetDescriptor = {
  name: string; label: string;
  data_models: { name: string; label: string; fields: { name: string; label: string; type: string; is_custom_measure: boolean }[] }[];
  metrics: { name: string; label: string; type: string }[];
};

export type DatasetShape = {
  descriptor: DatasetDescriptor;
  fields: Set<string>;                          // model.field
  metrics: { name: string; definition: string }[];
  fieldDefinitions: { fqn: string; definition: string }[];
};

export async function showDataset(baseUrl: string, dataset: string): Promise<DatasetShape> {
  const json = await call(baseUrl, 'show', { fqn: dataset });
  const obj = json.object ?? json;
  const fields = new Set<string>();
  const fieldDefinitions: { fqn: string; definition: string }[] = [];
  for (const model of obj.models ?? []) {
    for (const f of model.fields ?? []) {
      fields.add(f.fqn ?? `${model.name}.${f.name}`);
      if (f.definition) fieldDefinitions.push({ fqn: f.fqn, definition: String(f.definition) });
    }
  }
  const metrics = (obj.metrics ?? []).map((m: any) => ({ name: m.name, definition: String(m.definition ?? '') }));
  const descriptor: DatasetDescriptor = {
    name: obj.name ?? dataset,
    label: obj.label ?? dataset,
    data_models: (obj.models ?? []).map((model: any) => ({
      name: model.name,
      label: model.label ?? model.name,
      fields: (model.fields ?? []).filter((f: any) => !f.hidden).map((f: any) => ({
        name: f.name, label: f.label ?? f.name, type: f.type, is_custom_measure: f.role === 'measure',
      })),
    })),
    metrics: (obj.metrics ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ name: m.name, label: m.label ?? m.name, type: m.type })),
  };
  return { descriptor, fields, metrics, fieldDefinitions };
}
