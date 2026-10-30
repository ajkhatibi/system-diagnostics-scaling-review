import { check } from 'k6';
import http from 'k6/http';

const baseUrl = __ENV.BASE_URL || 'http://localhost:3001';

export const options = {
  discardResponseBodies: true,
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '60s',
};

export default function () {
  const response = http.get(`${baseUrl}/items`);
  check(response, {
    'GET /items returns 200': (result) => result.status === 200,
  });
}
