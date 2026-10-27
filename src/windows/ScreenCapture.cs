using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// 持久助手只在收到显式采集指令后读取一个完整显示器，像素仅通过内存管道返回。
internal static class ScreenCapture {
  private const int MaximumBytes = 128 * 1024 * 1024;
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct BitmapHeader {
    public uint Size; public int Width, Height; public ushort Planes, BitCount;
    public uint Compression, SizeImage; public int XPelsPerMeter, YPelsPerMeter; public uint ClrUsed, ClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo { public BitmapHeader Header; public uint Colors; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry {
    public uint Size, Usage, ProcessId; public UIntPtr DefaultHeap; public uint ModuleId, Threads, ParentId;
    public int Priority; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
  }
  private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
  [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
  [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
  [DllImport("gdi32.dll")] private static extern bool GdiFlush();
  [DllImport("dwmapi.dll")] private static extern int DwmFlush();
  [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

  private static bool IsParent(uint expected) {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return false;
    try {
      ProcessEntry entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32FirstW(snapshot, ref entry)) return false;
      uint own = (uint)Process.GetCurrentProcess().Id;
      do { if (entry.ProcessId == own) return entry.ParentId == expected; } while (Process32NextW(snapshot, ref entry));
      return false;
    } finally { CloseHandle(snapshot); }
  }

  private static bool IsWholeMonitor(int x, int y, int width, int height) {
    bool found = false;
    MonitorCallback callback = delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data) {
      if (rect.Left == x && rect.Top == y && (long)rect.Right - rect.Left == width && (long)rect.Bottom - rect.Top == height) found = true;
      return true;
    };
    return EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero) && found;
  }

  private sealed class Surface : IDisposable {
    private IntPtr screen, memory, bitmap, previous, bits;
    public readonly int Width, Height;
    public readonly byte[] Pixels;
    public Surface(int width, int height) {
      Width = width; Height = height; Pixels = new byte[checked(width * height * 4)];
      try {
        screen = GetDC(IntPtr.Zero); if (screen == IntPtr.Zero) throw new InvalidOperationException();
        memory = CreateCompatibleDC(screen); if (memory == IntPtr.Zero) throw new InvalidOperationException();
        BitmapInfo info = new BitmapInfo();
        info.Header.Size = (uint)Marshal.SizeOf(typeof(BitmapHeader)); info.Header.Width = width; info.Header.Height = -height;
        info.Header.Planes = 1; info.Header.BitCount = 32; info.Header.SizeImage = (uint)Pixels.Length;
        bitmap = CreateDIBSection(screen, ref info, 0, out bits, IntPtr.Zero, 0);
        if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) throw new InvalidOperationException();
        previous = SelectObject(memory, bitmap);
        if (previous == IntPtr.Zero || previous == new IntPtr(-1)) throw new InvalidOperationException();
      } catch { Dispose(); throw; }
    }
    public unsafe void Capture(int x, int y) {
      // 同步原生调用的合成节奏；宿主负责 Electron 窗口退隐，不能把此调用当作全会话刷新。
      if (DwmFlush() != 0 || !BitBlt(memory, 0, 0, Width, Height, screen, x, y, 0x40cc0020) || !GdiFlush()) throw new InvalidOperationException();
      uint* pointer = (uint*)bits.ToPointer(); int count = Pixels.Length / 4;
      // GDI 的第四字节不是有效透明度，统一设为不透明，供 Electron 按 BGRA 使用。
      for (int i = 0; i < count; i++) pointer[i] |= 0xff000000;
      Marshal.Copy(bits, Pixels, 0, Pixels.Length);
    }
    public unsafe void Clear() {
      Array.Clear(Pixels, 0, Pixels.Length);
      if (bits == IntPtr.Zero) return;
      uint* pointer = (uint*)bits.ToPointer(); int count = Pixels.Length / 4;
      for (int i = 0; i < count; i++) pointer[i] = 0;
    }
    public void Dispose() {
      if (memory != IntPtr.Zero && previous != IntPtr.Zero && previous != new IntPtr(-1)) SelectObject(memory, previous);
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      if (memory != IntPtr.Zero) DeleteDC(memory);
      if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
      screen = memory = bitmap = previous = bits = IntPtr.Zero;
    }
  }

  private static void UInt16(byte[] bytes, int offset, ushort value) { bytes[offset] = (byte)value; bytes[offset + 1] = (byte)(value >> 8); }
  private static void UInt32(byte[] bytes, int offset, uint value) { for (int i = 0; i < 4; i++) bytes[offset + i] = (byte)(value >> (8 * i)); }
  private static void Send(Stream output, ushort kind, uint id, int width, int height, byte[] payload, uint microseconds) {
    byte[] header = new byte[32]; header[0] = 80; header[1] = 71; header[2] = 83; header[3] = 67;
    UInt16(header, 4, 1); UInt16(header, 6, kind); UInt32(header, 8, id); UInt32(header, 12, (uint)width); UInt32(header, 16, (uint)height);
    UInt32(header, 20, payload == null ? 0 : (uint)payload.Length); UInt32(header, 24, microseconds);
    output.Write(header, 0, header.Length);
    if (payload != null) output.Write(payload, 0, payload.Length);
    output.Flush();
  }
  private static string ReadCommand(Stream input) {
    byte[] bytes = new byte[128]; int count = 0, value;
    while ((value = input.ReadByte()) >= 0) {
      if (value == 10) return Encoding.ASCII.GetString(bytes, 0, count);
      if (value == 13) continue;
      if (value < 32 || value > 126 || count == bytes.Length) throw new InvalidDataException();
      bytes[count++] = (byte)value;
    }
    if (count != 0) throw new InvalidDataException();
    return null;
  }

  private static int Main(string[] args) {
    Surface surface = null;
    try {
      uint owner;
      if (args.Length != 1 || !uint.TryParse(args[0], out owner) || !IsParent(owner)) return 2;
      using (Process parent = Process.GetProcessById((int)owner)) {
        parent.EnableRaisingEvents = true; parent.Exited += delegate { Environment.Exit(0); };
        if (parent.HasExited || !SetProcessDpiAwarenessContext(new IntPtr(-4))) return 2;
        using (Stream input = new BufferedStream(Console.OpenStandardInput(), 256))
        using (Stream output = Console.OpenStandardOutput()) {
          // 就绪握手只加载进程，不创建屏幕位图或读取任何像素。
          Send(output, 0, 0, 0, 0, null, 0);
          string command;
          while (!parent.HasExited && (command = ReadCommand(input)) != null) {
            string[] parts = command.Split(' '); uint id; int x, y, width, height;
            if (parts.Length != 6 || parts[0] != "C" || !uint.TryParse(parts[1], out id) || id == 0 ||
                !int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out x) || !int.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out y) ||
                !int.TryParse(parts[4], out width) || !int.TryParse(parts[5], out height)) return 3;
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || (long)width * height * 4 > MaximumBytes ||
                (long)x + width > int.MaxValue || (long)y + height > int.MaxValue || !IsWholeMonitor(x, y, width, height)) {
              Send(output, 2, id, 0, 0, Encoding.UTF8.GetBytes("只允许采集一个完整显示器的物理矩形。"), 0); continue;
            }
            try {
              Stopwatch timer = Stopwatch.StartNew();
              if (surface == null || surface.Width != width || surface.Height != height) { if (surface != null) surface.Dispose(); surface = new Surface(width, height); }
              surface.Capture(x, y); timer.Stop();
              Send(output, 1, id, width, height, surface.Pixels, (uint)Math.Min(uint.MaxValue, timer.Elapsed.TotalMilliseconds * 1000));
              surface.Clear();
            } catch {
              if (surface != null) { surface.Dispose(); surface = null; }
              Send(output, 2, id, 0, 0, Encoding.UTF8.GetBytes("Windows 屏幕读取失败，请使用后备采集。"), 0);
            }
          }
        }
      }
      return 0;
    } catch { return 4; }
    finally { if (surface != null) { surface.Clear(); surface.Dispose(); } }
  }
}
