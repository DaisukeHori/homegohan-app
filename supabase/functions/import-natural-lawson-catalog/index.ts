import { handleCatalogImportRequest } from "../_shared/catalog/import-runner.ts";

Deno.serve((req) =>
  handleCatalogImportRequest(req, {
    functionName: "import-natural-lawson-catalog",
    defaultSourceCode: "natural_lawson_jp",
    lockSourceCode: true,
  })
);
