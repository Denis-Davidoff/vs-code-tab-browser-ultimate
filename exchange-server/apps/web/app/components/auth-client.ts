import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
export const auth = createAuthClient({ plugins: [twoFactorClient()] });
