/**
 * Professional KLine chart component using klinecharts library in WebView
 * Supports technical indicators (MA, EMA, RSI, MACD, Bollinger Bands, etc.)
 * Drawing tools (trend lines, horizontal lines, Fibonacci retracements)
 * Crosshair, zoom, pan, and theme switching
 * 
 * KLINECHARTS LIBRARY IS BUNDLED LOCALLY FOR OFFLINE USE
 */

import React, { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { View, StyleSheet, ActivityIndicator, Text, Platform } from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview";
import { useTheme } from "@/components/ThemeProvider";
import { KLINECHARTS_LIB } from "./klinecharts_lib";
import type { Candle } from "@nraialgo/shared/api";

interface KLineChartProps {
  data: Candle[];
  height?: number;
}

type ChartMessage = 
  | { type: "ready" }
  | { type: "error"; message: string };

export default function KLineChart({ data, height = 400 }: KLineChartProps) {
  const { resolvedTheme } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const isReady = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const chartHtml = useMemo(() => {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <script>${KLINECHARTS_LIB}</script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { width: 100%; height: 100%; overflow: hidden; background: ${resolvedTheme === 'dark' ? '#0f172a' : '#ffffff'}; }
          #chart { width: 100%; height: 100%; }
          #error { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; color: ${resolvedTheme === 'dark' ? '#f1f5f9' : '#0f172a'}; font-family: sans-serif; padding: 20px; }
        </style>
      </head>
      <body>
        <div id="chart"></div>
        <div id="error">
          <p>⚠️ Chart failed to load</p>
          <p style="font-size: 12px; margin-top: 8px; color: #64748b;">Please reload the app</p>
        </div>
        <script>
          let chart = null;
          
          function showError(msg) {
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').innerHTML = '<p>⚠️ ' + msg + '</p><p style="font-size: 12px; margin-top: 8px; color: #64748b;">Please reload</p>';
            document.getElementById('chart').style.display = 'none';
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: msg }));
          }
          
          function initChart() {
            if (typeof klinecharts === 'undefined') {
              showError('Chart library not loaded');
              return;
            }
            
            try {
              const isDark = ${resolvedTheme === 'dark'};
              const colors = isDark ? {
                background: '#0f172a', text: '#f1f5f9', grid: '#334155',
                crosshair: '#64748b', up: '#22c55e', down: '#ef4444',
              } : {
                background: '#ffffff', text: '#0f172a', grid: '#e2e8f0',
                crosshair: '#64748b', up: '#16a34a', down: '#dc2626',
              };

              if (chart) chart.dispose();

              chart = klinecharts.init('chart', {
                styles: {
                  grid: { show: true, horizontal: { color: colors.grid }, vertical: { color: colors.grid } },
                  candle: {
                    priceMark: { high: { color: colors.up }, low: { color: colors.down }, last: { color: colors.text } },
                    bar: { upColor: colors.up, downColor: colors.down, noChangeColor: colors.text },
                  },
                  indicator: { text: { color: colors.text } },
                  xAxis: { axisLine: { color: colors.grid }, tickText: { color: colors.text } },
                  yAxis: { axisLine: { color: colors.grid }, tickText: { color: colors.text } },
                  crosshair: { horizontal: { color: colors.crosshair }, vertical: { color: colors.crosshair } },
                },
                toolbar: { visible: 'always' },
              });

              chart.createIndicator('MA', false, { id: 'candle_pane' });
              chart.createIndicator('VOL', true, { id: 'indicator_pane' });
              
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
            } catch (e) {
              showError('Init error: ' + e.message);
            }
          }

          function updateData(data) {
            if (!chart || !data || !data.length) return;
            try {
              const klineData = data.map(item => ({
                timestamp: item.timestamp,
                open: item.open,
                high: item.high,
                low: item.low,
                close: item.close,
                volume: item.volume || 0,
              }));
              chart.applyNewData(klineData);
            } catch (e) {
              console.error('Update error:', e);
            }
          }

          window.addEventListener('message', (event) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'init') initChart();
              else if (message.type === 'update') updateData(message.data);
            } catch (e) { 
              console.error('Message error:', e);
            }
          });

          window.addEventListener('load', () => {
            setTimeout(() => initChart(), 300);
          });
        </script>
      </body>
      </html>
    `;
  }, [resolvedTheme]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message: ChartMessage = JSON.parse(event.nativeEvent.data);
      if (message.type === "ready") {
        isReady.current = true;
        setLoading(false);
        setError(null);
        // Send data to chart
        if (webViewRef.current && data.length > 0) {
          webViewRef.current.postMessage(JSON.stringify({ type: "update", data }));
        }
      } else if (message.type === "error") {
        setError(message.message);
        setLoading(false);
      }
    } catch (e) {
      console.error("Chart message error:", e);
    }
  }, [data]);

  useEffect(() => {
    if (isReady.current && webViewRef.current && data.length > 0) {
      webViewRef.current.postMessage(JSON.stringify({ type: "update", data }));
    }
  }, [data]);

  return (
    <View style={[styles.container, { height }]}>
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
          <Text style={[styles.loadingText, { color: resolvedTheme === "dark" ? "#f1f5f9" : "#0f172a" }]}>
            Loading chart...
          </Text>
        </View>
      )}
      {error && !loading && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorSubtext}>Pull down to refresh</Text>
        </View>
      )}
      {chartHtml && (
        <WebView
          ref={webViewRef as any}
          source={{ html: chartHtml }}
          style={styles.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={resolvedTheme === "dark" ? "#38bdf8" : "#0284c7"} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    position: "relative",
  },
  webview: {
    flex: 1,
    backgroundColor: "transparent",
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.05)",
    zIndex: 1,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  errorOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    zIndex: 2,
    padding: 20,
  },
  errorText: {
    color: "#ef4444",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  errorSubtext: {
    color: "#94a3b8",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
  },
});
