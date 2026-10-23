// server/secrets.mjs
// Carga los secretos de SSM Parameter Store en process.env una vez por
// arranque en frío. El código de server.js sigue leyendo process.env como en
// Vercel, así que no hay que tocarlo.
//
// Si SECRETS_SSM_PREFIX no está definida (ejecución local, pruebas), se usa
// lo que haya en process.env y no se llama a SSM.
//
// El SDK v3 viene incluido en el runtime nodejs22.x de Lambda: no se empaqueta.

const SECRET_KEYS = [
  'SHOPIFY_ACCESS_TOKEN', // token de la app custom "favorites" (Admin API)
];

let loaded = null;

export async function loadSecrets() {
  if (loaded) return loaded;

  const prefix = process.env.SECRETS_SSM_PREFIX;
  if (!prefix) {
    loaded = { source: 'env', missing: [] };
    return loaded;
  }

  const { SSMClient, GetParametersCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({});
  const names = SECRET_KEYS.map((key) => `${prefix}/${key}`);
  const { Parameters = [], InvalidParameters = [] } = await client.send(
    new GetParametersCommand({ Names: names, WithDecryption: true })
  );

  for (const parameter of Parameters) {
    const key = parameter.Name.slice(prefix.length + 1);
    if (!process.env[key]) process.env[key] = parameter.Value;
  }

  const missing = InvalidParameters.map((name) => name.slice(prefix.length + 1));
  if (missing.length > 0) {
    console.warn('[secrets] No están en SSM:', missing.join(', '));
  }

  loaded = { source: 'ssm', missing };
  return loaded;
}

export function resetSecretsCache() {
  loaded = null;
}
