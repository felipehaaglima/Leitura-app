import { handleRequest } from '../server/index.js';

export default function handler(request, response) {
  return handleRequest(request, response, { hosted: true });
}
