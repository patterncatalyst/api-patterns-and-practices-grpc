{{- define "getquote.labels" -}}
app.kubernetes.io/part-of: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* restricted-v2: no runAsUser/runAsGroup/fsGroup — OpenShift assigns a UID
     from the namespace range. The ubi10/openjdk-25 S2I image tolerates an
     arbitrary UID with GID 0. */}}
{{- define "getquote.containerSecurity" -}}
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "getquote.image" -}}
{{ .Values.image.registry }}/{{ .Release.Namespace }}/{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{/* Pod template shared by the v1 Deployment and the v2 canary Deployment
     in mesh.yaml. dict: root (.), version ("v1"/"v2"). */}}
{{- define "getquote.podTemplate" -}}
{{- $ := .root -}}
metadata:
  labels:
    app.kubernetes.io/name: getquote
    app.kubernetes.io/part-of: {{ $.Release.Name }}
    {{- if $.Values.mesh.enabled }}
    istio.io/rev: {{ $.Values.mesh.revision }}
    version: {{ .version }}
    {{- end }}
  {{- if $.Values.observability.enabled }}
  annotations:
    instrumentation.opentelemetry.io/inject-java: {{ $.Values.observability.instrumentation | quote }}
  {{- end }}
spec:
  containers:
    - name: getquote
      image: {{ include "getquote.image" $ | quote }}
      imagePullPolicy: Always
      ports:
        - name: grpc
          containerPort: {{ $.Values.grpcPort }}
        - name: http
          containerPort: {{ $.Values.httpPort }}
      {{- if $.Values.tls.enabled }}
      env:
        # Quarkus config properties can be overridden by environment
        # variables at runtime (SmallRye Config's env mapping), so a
        # one-off diagnostic deploy can flip this app-level TLS demo on
        # with no rebuild. See the chapter's passthrough-Route diagnostic:
        # this is NOT the chart's default (plain-text, mesh-mTLS) shape —
        # turning it on conflicts with mesh mTLS on the same port (the
        # sidecar hands the app decrypted plaintext for a meshed caller,
        # which an app expecting a TLS ClientHello cannot parse), so this
        # flag is exercised with mesh.enabled=false.
        - name: QUARKUS_GRPC_SERVER_PLAIN_TEXT
          value: "false"
        - name: QUARKUS_GRPC_SERVER_SSL_CERTIFICATE
          value: /etc/getquote-tls/tls.crt
        - name: QUARKUS_GRPC_SERVER_SSL_KEY
          value: /etc/getquote-tls/tls.key
      volumeMounts:
        - name: tls
          mountPath: /etc/getquote-tls
          readOnly: true
      {{- end }}
      startupProbe:
        tcpSocket: {port: grpc}
        periodSeconds: 5
        failureThreshold: 60
      readinessProbe:
        tcpSocket: {port: grpc}
        periodSeconds: 10
      livenessProbe:
        tcpSocket: {port: grpc}
        periodSeconds: 10
      resources:
        {{- toYaml $.Values.resources | nindent 8 }}
      {{- include "getquote.containerSecurity" $ | nindent 6 }}
  {{- if $.Values.tls.enabled }}
  volumes:
    - name: tls
      secret:
        secretName: {{ $.Values.tls.secretName }}
  {{- end }}
{{- end -}}
