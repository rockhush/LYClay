import { registerBuiltinExtension } from '../loader';
import { createCompanyMarketplaceExtension } from './company-marketplace';
import { createLocalMarketplaceExtension } from './local-marketplace';
import { createDiagnosticsExtension } from './diagnostics';

export function registerAllBuiltinExtensions(): void {
  registerBuiltinExtension('builtin/local-marketplace', createLocalMarketplaceExtension);
  registerBuiltinExtension('builtin/company-marketplace', createCompanyMarketplaceExtension);
  registerBuiltinExtension('builtin/diagnostics', createDiagnosticsExtension);
}
