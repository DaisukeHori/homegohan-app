import { handleCatalogImportRequest } from "../_shared/catalog/import-runner.ts";

Deno.serve((req) =>
  handleCatalogImportRequest(req, {
    functionName: "import-lawson-catalog",
    defaultSourceCode: "lawson_jp",
    lockSourceCode: true,
  })
);
