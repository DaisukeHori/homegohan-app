import { handleCatalogImportRequest } from "../_shared/catalog/import-runner.ts";

Deno.serve((req) =>
  handleCatalogImportRequest(req, {
    functionName: "import-seven-eleven-catalog",
    defaultSourceCode: "seven_eleven_jp",
    lockSourceCode: true,
  })
);
