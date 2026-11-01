// Loaded as an external script so the page needs no inline-script CSP exception.
window.ui = SwaggerUIBundle({
  url: '/reference/openapi.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
  persistAuthorization: false,
});
