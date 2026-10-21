import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")

from shop.observability import init_observability  # noqa: E402

# runserver and gunicorn (without --preload) import this module in the
# process that serves requests, so tracing starts there, after any fork.
init_observability()

from django.core.wsgi import get_wsgi_application  # noqa: E402

application = get_wsgi_application()
