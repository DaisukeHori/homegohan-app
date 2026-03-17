import { handleCatalogImportRequest } from "../_shared/catalog/import-runner.ts";

Deno.serve((req) =>
  handleCatalogImportRequest(req, {
    functionName: "import-convenience-catalog",
  })
);
