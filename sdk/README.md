# AppWeave SDK

The SDK connects independently hosted frontends to the AppWeave managed backend. It contains only the public client identifier; never place server secrets or database credentials in a frontend.

```ts
import { createAppWeaveClient } from "@appweave/sdk";
const client = createAppWeaveClient({ baseUrl: "https://api.example.com", publicClientId: "aw_public_..." });
const session = await client.login(email, password);
client.setToken(session.token);
const { products } = await client.products(projectId);
```
