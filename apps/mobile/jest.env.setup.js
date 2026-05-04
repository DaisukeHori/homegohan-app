// Skip RNTL peer deps version check
// This is needed because the monorepo root has react@18 (for Next.js) while
// apps/mobile uses react@19. The check incorrectly picks up the root version.
process.env.RNTL_SKIP_DEPS_CHECK = '1';
