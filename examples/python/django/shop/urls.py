from django.urls import path

from shop import views

urlpatterns = [
    path("health", views.health),
    path("ok", views.health),
    path("orders/<int:order_id>", views.order),
    path("orders/<int:order_id>/charge", views.charge),
    path("orders/<int:order_id>/refund", views.refund),
]
