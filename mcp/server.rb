# frozen_string_literal: true

# Omacommand MCP server (spec 7). Ruby standard library only: json, open3, securerandom.
#
# Run it as:  /usr/bin/ruby --disable=gems,rubyopt <plugin folder>/mcp/server.rb
#
# It speaks JSON-RPC 2.0 on stdin and stdout, one message per line, and nothing else. It passes plans through untouched:
# the QML service inside the Omarchy shell is the only place that knows the vocabulary and the only one that validates.
# It talks to that service by running "omarchy-shell io.github.lavart.omacommand <function> [argument]" as an argv list.

require "json"
require "open3"
require "securerandom"

module Omacommand
  VERSION = "1.0.0"
  TARGET = "io.github.lavart.omacommand"
  PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].freeze

  MAX_LINE = 65_536 # bytes in one stdin line (spec 7.1)
  MAX_REQUEST = 16_384 # characters in one request to the service (spec 3.5)
  MAX_NESTING = 16
  CHILD_TIMEOUT = 5 # seconds before a child process is stopped
  CHILD_OUTPUT_MAX = 65_536
  CALL_SECONDS = 50 # propose_desk_plan answers within this (spec 7.3)
  RESULT_SECONDS = 20 # desk_plan_result waits up to this
  POLL_SECONDS = 0.5
  # One status call can take about this long: a hung "Target not found" answer takes 2 to 3 s, the 1 s retry wait, and a second
  # call. No poll starts when the window would end before it could finish, so the answer stays inside the client's limit.
  STATUS_WORST = 7
  PROGRESS_SECONDS = 5
  MAX_IDS = 1000
  FINAL_STATES = %w[done failed denied timeout refused].freeze
  TOOL_NAMES = %w[propose_desk_plan desk_plan_result desk_state].freeze

  OPEN_FLAGS = File::RDONLY |
               (defined?(File::NOFOLLOW) ? File::NOFOLLOW : 0) |
               (defined?(File::NONBLOCK) ? File::NONBLOCK : 0)

  INSTRUCTIONS = "Omacommand lets you propose desktop steps from a fixed list. The person sees exactly those steps in a box " \
                 "and must click Allow. Use propose_desk_plan, then desk_plan_result if it is still running, and desk_state " \
                 "to see the workspaces."

  # Every sentence the server says itself (spec 7.5). None of them repeats input.
  module Say
    NOT_RUNNING = "The Omarchy shell is not running, so no box can be shown. Nothing ran."
    NOT_ENABLED = "Omacommand is not enabled. Ask the person to run: omarchy plugin enable io.github.lavart.omacommand"
    NO_ANSWER = "The Omarchy shell did not answer, so no box was shown. Nothing ran."
    NO_ANSWER_LAST = "The Omarchy shell did not answer the last check, so the request may still be waiting for the person or running."
    BAD_ANSWER = "The answer from Omacommand could not be read."
    UNREACHABLE = "Omacommand could not be reached."
    TOO_LARGE = "The request is too large."
    NOT_WRITTEN = "The request could not be written."
    BUSY_CALL = "Omacommand is still handling your earlier request. Try again after it ends."
    NEEDS_STEPS = "propose_desk_plan needs an object with one field, steps, which is a list."
    NEEDS_ID = "desk_plan_result needs an object with one field, id, from propose_desk_plan."
    NEEDS_NOTHING = "desk_state takes no arguments."
    UNKNOWN_ID = "Omacommand does not know that request id."
    CANCELLED = "The call was cancelled."
    RESTARTED_WAITING = "The Omarchy shell restarted while your request was waiting, so nothing ran."
    RESTARTED_RUNNING = "The Omarchy shell restarted while the steps were running. Some steps may have run; call desk_state to see the desktop now."
  end

  module Clock
    def self.now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end

  # Text that goes back to the agent: printable ASCII only, one line, capped.
  module Text
    def self.ascii(value, max = 400)
      s = value.to_s.dup.force_encoding(Encoding::UTF_8).scrub("?")
      s = s.gsub(/[^\x20-\x7E]/, "?").gsub(/ +/, " ").strip
      s[0, max]
    end

    def self.client_name(value)
      s = value.to_s
      s.match?(/\A[A-Za-z0-9 ._-]{1,32}\z/) ? s : "unknown"
    end
  end

  # One child process, started from an argv array (never a string, so never a shell), with a deadline and an output cap.
  module Child
    Result = Struct.new(:missing, :timed_out, :out, :err, :ok, keyword_init: true)

    def self.run(argv)
      raise ArgumentError, "argv must be an array of at least two" unless argv.is_a?(Array) && argv.length >= 2

      out = String.new(encoding: Encoding::BINARY)
      err = String.new(encoding: Encoding::BINARY)
      stdin = stdout = stderr = waiter = nil
      begin
        stdin, stdout, stderr, waiter = Open3.popen3(*argv, close_others: true)
      rescue SystemCallError
        return Result.new(missing: true, timed_out: false, out: out, err: err, ok: false)
      end
      stdin.close
      pid = waiter.pid
      deadline = Clock.now + CHILD_TIMEOUT
      open_ios = [stdout, stderr]
      timed_out = false
      until open_ios.empty?
        left = deadline - Clock.now
        if left <= 0
          timed_out = true
          break
        end
        ready = IO.select(open_ios, nil, nil, left)
        next if ready.nil?

        ready[0].each do |io|
          chunk = io.read_nonblock(4096, exception: false)
          if chunk == :wait_readable
            next
          elsif chunk.nil?
            open_ios.delete(io)
          else
            buf = io.equal?(stdout) ? out : err
            buf << chunk if buf.bytesize < CHILD_OUTPUT_MAX
          end
        end
      end
      ok = false
      if timed_out
        stop(pid, waiter)
      elsif waiter.join(1)
        ok = waiter.value.success?
      else
        stop(pid, waiter)
      end
      Result.new(missing: false, timed_out: timed_out, out: out, err: err, ok: ok)
    ensure
      [stdout, stderr].each { |io| io.close if io && !io.closed? }
    end

    # TERM first, KILL a second later.
    def self.stop(pid, waiter)
      Process.kill("TERM", pid)
      return if waiter.join(1)

      Process.kill("KILL", pid)
      waiter.join(1)
    rescue SystemCallError
      nil
    end
  end

  # Calls to the QML service through omarchy-shell (spec 6.2, 7.5).
  module Service
    def self.call(fn, arg = nil)
      argv = ["omarchy-shell", TARGET, fn]
      argv << arg unless arg.nil?
      res = Child.run(argv)
      kind = classify(res)
      if kind == :not_enabled
        # The same answer shows for under a second while the shell restarts, so ask once more (spec 7.5).
        sleep 1
        res = Child.run(argv)
        kind = classify(res)
      end
      return [kind, nil] unless kind == :ok

      data = parse(res.out)
      data.nil? ? [:bad_answer, nil] : [:ok, data]
    end

    def self.classify(res)
      return :no_binary if res.missing
      return :timeout if res.timed_out
      return :ok if res.ok

      text = "#{res.err} #{res.out}"
      return :not_running if text.include?("omarchy-shell is not running")
      return :not_enabled if text.include?("Target not found")
      return :not_responding if text.include?("not responding") || text.include?("not ready")

      :other
    end

    def self.parse(out)
      s = out.to_s.dup.force_encoding(Encoding::UTF_8)
      return nil unless s.valid_encoding?

      data = JSON.parse(s.strip, max_nesting: MAX_NESTING, create_additions: false)
      data.is_a?(Hash) ? data : nil
    rescue JSON::ParserError
      nil
    end

    # The sentence for a failed call, or nil when the call worked.
    def self.failure_text(kind)
      case kind
      when :ok then nil
      when :no_binary, :not_running then Say::NOT_RUNNING
      when :not_enabled then Say::NOT_ENABLED
      when :timeout, :not_responding then Say::NO_ANSWER
      when :bad_answer then Say::BAD_ANSWER
      else Say::UNREACHABLE
      end
    end
  end

  # notifications/progress every few seconds while a call waits (spec 7.3).
  class Progress
    def initialize(server, token)
      @server = server
      @token = token
      @count = 0
      @last = Clock.now
    end

    def tick(state)
      return if @token.nil?
      return if Clock.now - @last < PROGRESS_SECONDS

      @last = Clock.now
      @count += 1
      message = state == "running" ? "The steps are running." : "Waiting for the person to answer."
      @server.notify("notifications/progress", { "progressToken" => @token, "progress" => @count, "message" => message })
    end
  end

  class Server
    attr_reader :tools

    def initialize
      @out_lock = Mutex.new
      @tools = load_tools
      @client = "unknown"
      @made_ids = {}
      @made_order = []
      @busy = false
      @cancelled = false
      @current_id = nil
    end

    # ---- the file of tool definitions (written by scripts/build_tools.mjs)
    def load_tools
      path = File.join(__dir__, "tools.json")
      File.open(path, OPEN_FLAGS) do |f|
        st = f.stat
        raise "tools.json is not a plain file" unless st.file? && st.size <= 65_536

        data = JSON.parse(f.read(65_537).force_encoding(Encoding::UTF_8), max_nesting: MAX_NESTING, create_additions: false)
        list = data.is_a?(Hash) ? data["tools"] : nil
        ok = list.is_a?(Array) && list.length == TOOL_NAMES.length &&
             list.all? { |t| t.is_a?(Hash) && TOOL_NAMES.include?(t["name"]) && t["inputSchema"].is_a?(Hash) }
        raise "tools.json is not the expected list" unless ok

        list
      end
    end

    # ---- output: stdout carries only JSON-RPC lines
    def emit(obj)
      line = begin
        JSON.generate(obj, ascii_only: true)
      rescue StandardError
        nil
      end
      if line.nil?
        id = obj.is_a?(Hash) && (obj["id"].is_a?(Integer) || obj["id"].is_a?(String)) ? obj["id"] : nil
        line = JSON.generate({ "jsonrpc" => "2.0", "id" => id, "error" => { "code" => -32_603, "message" => "The answer could not be written." } })
      end
      @out_lock.synchronize do
        $stdout.write("#{line}\n")
        $stdout.flush
      end
    end

    def send_result(id, result)
      emit({ "jsonrpc" => "2.0", "id" => id, "result" => result })
    end

    def send_error(id, code, message)
      emit({ "jsonrpc" => "2.0", "id" => id, "error" => { "code" => code, "message" => message } })
    end

    def notify(method, params)
      emit({ "jsonrpc" => "2.0", "method" => method, "params" => params })
    end

    # ---- input: lines of at most MAX_LINE bytes (spec 7.1)
    def read_line
      line = $stdin.gets("\n", MAX_LINE + 1)
      return [:eof, nil] if line.nil?
      return [:line, line.chomp] if line.end_with?("\n")
      return [:line, line] if line.bytesize < MAX_LINE + 1

      drain_rest
      [:long, nil]
    end

    # Reads the rest of an over-long line away in chunks, keeping nothing.
    def drain_rest
      loop do
        chunk = $stdin.gets("\n", MAX_LINE)
        break if chunk.nil? || chunk.end_with?("\n")
      end
    end

    def run
      $stdin.binmode
      $stdout.binmode
      loop do
        kind, line = read_line
        break if kind == :eof

        if kind == :long
          send_error(nil, -32_700, "The line is too long.")
          next
        end
        handle_line(line)
      end
    end

    def handle_line(line)
      return if line.strip.empty? # the line is still binary here, so this cannot fail on bad UTF-8

      text = line.dup.force_encoding(Encoding::UTF_8)
      msg = begin
        raise JSON::ParserError, "bad encoding" unless text.valid_encoding?

        JSON.parse(text, max_nesting: MAX_NESTING, create_additions: false)
      rescue JSON::ParserError
        nil
      end
      if msg.nil?
        send_error(nil, -32_700, "Parse error.")
        return
      end
      handle_message(msg)
    end

    def valid_id?(id)
      (id.is_a?(Integer) && id.abs < 2**53) || (id.is_a?(String) && id.length <= 256)
    end

    def handle_message(msg)
      unless msg.is_a?(Hash)
        send_error(nil, -32_600, "Invalid request.")
        return
      end
      has_id = msg.key?("id")
      id = msg["id"]
      if has_id && !valid_id?(id)
        send_error(nil, -32_600, "Invalid request.")
        return
      end
      method = msg["method"]
      unless msg["jsonrpc"] == "2.0" && method.is_a?(String)
        # Answers or junk from the client: the server sends no requests, so there is nothing to match them with.
        send_error(id, -32_600, "Invalid request.") if has_id && !msg.key?("result") && !msg.key?("error")
        return
      end
      unless has_id
        handle_notification(method, msg["params"])
        return
      end
      case method
      when "initialize" then send_result(id, initialize_result(msg["params"]))
      when "ping" then send_result(id, {})
      when "tools/list" then send_result(id, { "tools" => @tools })
      when "tools/call" then tools_call(id, msg["params"])
      else send_error(id, -32_601, "Method not found.")
      end
    end

    def handle_notification(method, params)
      return unless method == "notifications/cancelled"
      return unless params.is_a?(Hash) && @busy && params["requestId"] == @current_id

      @cancelled = true
    end

    def initialize_result(params)
      params = {} unless params.is_a?(Hash)
      info = params["clientInfo"]
      @client = Text.client_name(info.is_a?(Hash) ? info["name"] : nil)
      wanted = params["protocolVersion"]
      {
        "protocolVersion" => PROTOCOLS.include?(wanted) ? wanted : PROTOCOLS.first,
        "capabilities" => { "tools" => {} },
        "serverInfo" => { "name" => "omacommand", "version" => VERSION },
        "instructions" => INSTRUCTIONS
      }
    end

    # ---- tools
    def tools_call(id, params)
      unless params.is_a?(Hash) && params["name"].is_a?(String)
        send_error(id, -32_602, "Invalid params.")
        return
      end
      name = params["name"]
      unless TOOL_NAMES.include?(name)
        send_error(id, -32_602, "Unknown tool.")
        return
      end
      args = params.key?("arguments") ? params["arguments"] : {}
      unless args.is_a?(Hash)
        send_error(id, -32_602, "Arguments must be an object.")
        return
      end
      meta = params["_meta"]
      token = meta.is_a?(Hash) ? meta["progressToken"] : nil
      token = nil unless (token.is_a?(String) && token.length <= 128) || (token.is_a?(Integer) && token.abs < 2**53)
      launch(id, name, args, token)
    end

    # The long wait runs on its own thread, so the reader still answers pings and cancellations.
    def launch(id, name, args, token)
      if @busy
        send_result(id, text_result(Say::BUSY_CALL, true))
        return
      end
      @busy = true
      @cancelled = false
      @current_id = id
      Thread.new do
        begin
          text, error = run_tool(name, args, Progress.new(self, token))
          answer = -> { send_result(id, text_result(text, error)) }
        rescue StandardError
          answer = -> { send_error(id, -32_603, "Internal error.") }
        ensure
          # The slot is free before the answer goes out: a client's next call can come the moment it reads this one.
          cancelled = @cancelled
          @busy = false
        end
        answer.call unless cancelled
      end
    end

    def text_result(text, error)
      { "content" => [{ "type" => "text", "text" => text }], "isError" => error ? true : false }
    end

    def run_tool(name, args, progress)
      case name
      when "propose_desk_plan" then tool_propose(args, progress)
      when "desk_plan_result" then tool_result(args, progress)
      else tool_state(args)
      end
    end

    def remember(id)
      @made_ids[id] = true
      @made_order << id
      @made_ids.delete(@made_order.shift) while @made_order.length > MAX_IDS
    end

    def tool_propose(args, progress)
      started = Clock.now
      return [Say::NEEDS_STEPS, true] unless args.keys == ["steps"] && args["steps"].is_a?(Array)

      id = SecureRandom.hex(16)
      request = {
        "v" => 1, "id" => id, "sent_at" => (Time.now.to_f * 1000).to_i, "client" => @client,
        "plan" => { "steps" => args["steps"] }
      }
      json = begin
        JSON.generate(request, ascii_only: true)
      rescue StandardError
        nil
      end
      return [Say::NOT_WRITTEN, true] if json.nil?
      return [Say::TOO_LARGE, true] if json.length > MAX_REQUEST

      remember(id)
      kind, ans = Service.call("propose", json)
      if kind == :ok
        return [Text.ascii(ans["message"] || Say::UNREACHABLE), true] unless ans["ok"] == true && ans["id"] == id

        return wait_for_result(id, [CALL_SECONDS - (Clock.now - started), 1].max, progress)
      end
      if %i[timeout not_responding].include?(kind)
        # The call may have reached the service even though no answer came back: ask for the record (spec 7.3).
        3.times do
          sleep POLL_SECONDS
          k2, a2 = Service.call("status", id)
          next unless k2 == :ok

          state = a2["state"]
          return wait_for_result(id, [CALL_SECONDS - (Clock.now - started), 1].max, progress) if state != "unknown"
        end
        return [Say::NO_ANSWER, true]
      end
      [Service.failure_text(kind) || Say::UNREACHABLE, true]
    end

    def tool_result(args, progress)
      id = args["id"]
      return [Say::NEEDS_ID, true] unless args.keys == ["id"] && id.is_a?(String) && id.match?(/\A[0-9a-f]{32}\z/)
      return [Say::UNKNOWN_ID, true] unless @made_ids.key?(id)

      wait_for_result(id, RESULT_SECONDS, progress)
    end

    def tool_state(args)
      return [Say::NEEDS_NOTHING, true] unless args.empty?

      kind, ans = Service.call("state")
      failure = Service.failure_text(kind)
      return [failure, true] if failure
      return [Text.ascii(ans["message"] || Say::UNREACHABLE), true] if ans["ok"] == false

      text = begin
        JSON.generate(ans, ascii_only: true)
      rescue StandardError
        nil
      end
      text.nil? ? [Say::BAD_ANSWER, true] : [text, false]
    end

    # Polls status(id) every half second until the state is final or the window ends (spec 7.3, 6.6).
    def wait_for_result(id, window, progress)
      deadline = Clock.now + window
      seen = nil
      misses = 0
      loop do
        return [Say::CANCELLED, true] if @cancelled

        kind, ans = Service.call("status", id)
        if kind == :ok
          misses = 0
          state = ans["state"]
          if FINAL_STATES.include?(state)
            return render_final(ans)
          elsif %w[pending running].include?(state)
            seen = state
          elsif state == "unknown"
            return [lost_message(seen), true]
          end
        else
          misses += 1
        end
        # The next poll would start after the pause and could take STATUS_WORST seconds: stop while there is still room.
        return [window_end_message(id, seen, misses), misses.positive? || seen.nil?] if deadline - Clock.now - POLL_SECONDS < STATUS_WORST

        progress.tick(seen)
        sleep POLL_SECONDS
      end
    end

    def lost_message(seen)
      case seen
      when "pending" then Say::RESTARTED_WAITING
      when "running" then Say::RESTARTED_RUNNING
      else Say::NO_ANSWER
      end
    end

    # The window ended. When the last poll got no answer the request may still be open or running, so this never says that
    # nothing ran: it says the shell did not answer and points at desk_plan_result (review C13).
    def window_end_message(id, seen, misses)
      return "#{Say::NO_ANSWER_LAST} Call desk_plan_result with id #{id} in a few seconds." if misses.positive?
      return "The person allowed it. The steps are still running. Call desk_plan_result with id #{id} in a few seconds." if seen == "running"

      "Still waiting for the person to answer. Call desk_plan_result with id #{id} in a few seconds."
    end

    # Plain sentences the agent can repeat. Everything is cleaned to printable ASCII first.
    def render_final(ans)
      state = ans["state"]
      parts = [Text.ascii(ans["message"])]
      steps = ans["steps"].is_a?(Array) ? ans["steps"].first(12) : []
      steps.each_with_index do |s, i|
        next unless s.is_a?(Hash) && s["ok"] == true

        parts << "#{i + 1}. #{Text.ascii(s['note'], 160).sub(/\.\z/, '')}."
      end
      [parts.join(" "), !%w[done denied timeout].include?(state)]
    end
  end

  # The --check flag: one line per check, OK or FIX with the exact command (spec 7.6). It never proposes anything.
  module Check
    def self.run(show_log)
      ok = true
      line = lambda do |good, text|
        puts(good ? "OK #{text}" : "FIX #{text}")
        ok &&= good
      end

      if (RUBY_VERSION.split(".").map(&:to_i) <=> [3, 0]) >= 0
        line.call(true, "Ruby #{RUBY_VERSION} with json #{JSON::VERSION}.")
      else
        line.call(false, "Ruby #{RUBY_VERSION} is older than 3.0 : update your system packages, then run this check again.")
      end

      runtime = ENV["XDG_RUNTIME_DIR"].to_s
      if runtime.empty?
        line.call(false, "XDG_RUNTIME_DIR is not set : run this from a terminal in your Omarchy desktop.")
      else
        line.call(true, "XDG_RUNTIME_DIR is set.")
      end

      shell = find_in_path("omarchy-shell")
      if shell
        line.call(true, "omarchy-shell is at #{Text.ascii(shell, 200)}.")
      else
        line.call(false, "omarchy-shell was not found on PATH : Omacommand needs Omarchy 4, run this from a terminal in your Omarchy desktop.")
      end

      # omarchy-shell refuses to run without it. A terminal over SSH, or a service, usually does not have it (review C14).
      omarchy_path_set = !ENV["OMARCHY_PATH"].to_s.empty?
      if omarchy_path_set
        line.call(true, "OMARCHY_PATH is set.")
      else
        line.call(false, "OMARCHY_PATH is not set : run this from a terminal in your Omarchy desktop, where omarchy-shell can find the shell.")
      end

      dir = File.expand_path("..", __dir__)
      manifest = read_small(File.join(dir, "manifest.json"), 65_536)
      data = begin
        manifest ? JSON.parse(manifest.dup.force_encoding(Encoding::UTF_8), max_nesting: MAX_NESTING, create_additions: false) : nil
      rescue JSON::ParserError
        nil
      end
      if data.is_a?(Hash) && data["id"] == TARGET
        line.call(true, "The plugin folder is #{Text.ascii(dir, 200)}.")
      else
        line.call(false, "The plugin folder or its manifest.json is missing or wrong : omarchy plugin add https://github.com/lAvArt/omacommand --enable")
      end

      commit = git(dir, "rev-parse", "HEAD")
      if commit.nil?
        puts "OK The installed commit is unknown (this is not a git copy, or git is missing)."
      else
        puts "OK The installed commit is #{Text.ascii(commit, 64)} : compare it with CHANGELOG.md on GitHub."
        changed = git(dir, "status", "--porcelain")
        if changed.nil?
          line.call(false, "Could not check whether Omacommand's files were changed after they were added, because git status failed : git -C #{Text.ascii(dir, 200)} status --porcelain")
        elsif changed.empty?
          line.call(true, "The files are as they were installed.")
        else
          line.call(false, "Omacommand's files were changed after it was installed. If you did not change them, reinstall : omarchy plugin remove io.github.lavart.omacommand --yes && omarchy plugin add https://github.com/lAvArt/omacommand --enable")
        end
      end

      kind, ans = Service.call("ping")
      if kind == :ok && ans["ready"] == true
        line.call(true, "Omacommand answers in the Omarchy shell.")
      elsif %i[not_running no_binary].include?(kind)
        line.call(false, "The Omarchy shell is not running : log in to your Omarchy desktop and run this check there.")
      elsif kind == :not_enabled
        line.call(false, "Omacommand is not enabled : omarchy plugin enable io.github.lavart.omacommand")
      elsif !omarchy_path_set
        line.call(false, "Omacommand could not be asked, because OMARCHY_PATH is not set : see the OMARCHY_PATH line above.")
      else
        line.call(false, "Omacommand did not answer : omarchy-shell shell rescanPlugins")
      end

      begin
        server = Server.new
        init = server.initialize_result({ "protocolVersion" => PROTOCOLS.first, "clientInfo" => { "name" => "check" } })
        good = init.is_a?(Hash) && init["capabilities"] == { "tools" => {} } && server.tools.length == TOOL_NAMES.length
        line.call(good, good ? "This server answers initialize and tools/list (#{server.tools.length} tools)." : "This server did not answer initialize and tools/list : reinstall Omacommand.")
      rescue StandardError
        line.call(false, "This server could not load mcp/tools.json : reinstall Omacommand.")
      end

      puts "NOTE If your agent can run terminal commands without asking you, it can control the desktop without Omacommand. See SECURITY.md."
      print_log if show_log
      ok ? 0 : 1
    end

    def self.find_in_path(name)
      ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |d|
        next if d.empty?

        path = File.join(d, name)
        return path if File.file?(path) && File.executable?(path)
      end
      nil
    end

    # Opens without following a link and without blocking on a FIFO; reads only a regular file of at most limit bytes.
    def self.read_small(path, limit)
      File.open(path, OPEN_FLAGS) do |f|
        st = f.stat
        return nil unless st.file? && st.size <= limit

        f.read(limit + 1)
      end
    rescue SystemCallError
      nil
    end

    def self.git(dir, *args)
      res = Child.run(["git", "-C", dir] + args)
      return nil if res.missing || res.timed_out || !res.ok

      res.out.to_s.strip
    end

    def self.print_log
      xdg = ENV["XDG_STATE_HOME"].to_s
      base = xdg.start_with?("/") ? xdg : File.join(ENV["HOME"].to_s, ".local", "state")
      text = read_small(File.join(base, "omacommand", "events.log"), 65_536)
      if text.nil?
        puts "NOTE There is no log to show yet."
        return
      end
      text.to_s.dup.force_encoding(Encoding::UTF_8).scrub("?").lines.last(20).each do |l|
        puts "LOG #{Text.ascii(l, 200)}"
      end
    end
  end

  def self.main(argv)
    Thread.report_on_exception = false
    case argv
    when []
      $stdout.sync = true
      Server.new.run
      0
    when ["--version"]
      puts "omacommand #{VERSION}"
      0
    when ["--check"]
      Check.run(false)
    when ["--check", "--log"]
      Check.run(true)
    else
      warn "usage: server.rb [--check [--log] | --version]"
      2
    end
  rescue StandardError
    warn "omacommand: fatal error"
    1
  end
end

exit(Omacommand.main(ARGV)) if $PROGRAM_NAME == __FILE__
