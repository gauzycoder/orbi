import { handleRequest } from "../../../lib/api.mjs";

async function handler(request, { params }) {
  const { path } = await params;
  return handleRequest(request, path.join("/"));
}

export { handler as GET, handler as POST };
