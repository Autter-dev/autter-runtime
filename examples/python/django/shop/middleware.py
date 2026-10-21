from django.core.exceptions import BadRequest, PermissionDenied, SuspiciousOperation
from django.core.handlers.exception import response_for_exception
from django.http import Http404

CLIENT_ERRORS = (Http404, PermissionDenied, BadRequest, SuspiciousOperation)


class ClientErrorResponses:
    """Answer Django's 4xx exceptions before OpenTelemetry records them.

    Django turns Http404, PermissionDenied, BadRequest and SuspiciousOperation
    into 4xx responses, but OpenTelemetry's Django middleware records each one
    as an exception with ERROR status first, so every get_object_or_404 miss
    would become an Autter issue. Django calls process_exception from the last
    middleware to the first, and OpenTelemetry's is inserted first, so this one,
    anywhere in MIDDLEWARE, answers them with Django's own response before
    OpenTelemetry's sees them. Everything else, 500s included, passes through.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exception):
        if isinstance(exception, CLIENT_ERRORS):
            return response_for_exception(request, exception)
        return None
