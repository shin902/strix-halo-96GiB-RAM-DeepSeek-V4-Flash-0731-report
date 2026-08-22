現在のROCm runtimeで動く最高精度のK160 MTPを生成しました。

 ```text
   /home/shi/models/DeepSeek-V4-Flash-0731/DeepSeek-V4-Flash-0731-K160-REAP-MTP-Q8_0-ROCm.gguf
 ```

 構成:

 ```text
   expert数: 160
   routed experts: Q8_0
   attention/projection/shared experts: Q8_0
   norm/router: runtime互換のF32/F16
   サイズ: 約4.15 GiB
 ```
