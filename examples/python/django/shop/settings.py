"""Minimal settings: no database, no templates, DEBUG off as in production."""

import os

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "recipe-only-not-a-secret")
DEBUG = False
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
ROOT_URLCONF = "shop.urls"
WSGI_APPLICATION = "shop.wsgi.application"
INSTALLED_APPS = ["shop"]
MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
    # Keeps Http404 & co. from being recorded as errors (see the class).
    "shop.middleware.ClientErrorResponses",
]
DATABASES = {}
USE_TZ = True
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "WARNING"},
}
