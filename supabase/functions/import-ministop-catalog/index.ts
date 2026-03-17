import { handleCatalogImportRequest } from "../_shared/catalog/import-runner.ts";

Deno.serve((req) =>
  handleCatalogImportRequest(req, {
    functionName: "import-ministop-catalog",
    defaultSourceCode: "ministop_jp",
    lockSourceCode: true,
  })
);
