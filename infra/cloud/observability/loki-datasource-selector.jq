# loki-datasource-selector.jq — the canonical rule for choosing the Loki
# datasource on a hosted Grafana tenant.
#
# WHY THIS IS A FILE
# ------------------
# The rule used to be written twice: once as an inline jq program in
# `bootstrap-observability.sh` and once in the operator procedure in
# `docs/systems/observability.md`. Two copies of a selection rule drift,
# and the drift is invisible until an operator query answers "no rows"
# against a healthy telemetry pipeline. The rule now lives HERE, and both
# the provisioning script and the documented operator path run this file,
# so they cannot disagree.
#
# USAGE
#   jq -r --arg override "${GRAFANA_CLOUD_LOKI_DATASOURCE_UID:-}" \
#       -f infra/cloud/observability/loki-datasource-selector.jq
#
# INPUT
#   The `/api/datasources` response: an array of datasource objects.
#
# OUTPUT
#   The selected datasource uid, or nothing when the tenant has no Loki
#   datasource at all.
#
# THE RULE
#   A hosted Grafana Cloud tenant exposes several Loki datasources at
#   once: the canonical application-logs one (`<stack>-logs`) plus
#   purpose-built ones (alert-state history, usage insights). None of them
#   is the tenant default when Prometheus holds that flag, so the old
#   "default first, otherwise the first Loki datasource" rule bound every
#   Loki-backed dashboard to whichever the tenant happened to list first.
#   On the live Sindustries tenant that was
#   `grafanacloud-alert-state-history`, which never receives application
#   logs — the rows sit in `grafanacloud-logs`.
#
#   1. An operator pin (`GRAFANA_CLOUD_LOKI_DATASOURCE_UID`) wins over
#      every naming convention — and it wins ALONE. A pin that matches no
#      Loki datasource produces NO output: the pin is authoritative, so a
#      stale or mistyped pin must not silently fall back to a rule that is
#      known not to work on that tenant. The caller fails closed.
#   2. The canonical application-logs datasource (a `logs` uid/name
#      suffix).
#   3. The tenant default, when it is a Loki datasource.
#   4. The first Loki datasource.
#
#   A production tenant whose provider exposes no environment label at all
#   is unaffected: there is nothing to contradict.

map(select(.type == "loki"))
| (
    if ($override // "") != "" then
      [ map(select(.uid == $override))[0] ]
    else
      [
        map(
          select(
            ((.uid // "") | test("(^|-)logs$"))
            or ((.name // "") | test("(^|[- ])logs$"))
          )
        )[0]
      ]
      + [ map(select(.isDefault == true))[0] ]
      + [ .[0] ]
    end
  )
| map(select(. != null))
| .[0]
| .uid // empty
