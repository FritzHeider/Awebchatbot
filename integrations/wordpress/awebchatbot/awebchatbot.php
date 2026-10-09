<?php
/**
 * Plugin Name:       AWebChatbot
 * Description:       AI chatbot and live chat widget powered by your AWebChatbot Cloudflare Worker.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * License:           MIT
 * Text Domain:       awebchatbot
 */

if (!defined('ABSPATH')) {
    exit;
}

const AWEBCHATBOT_OPTION = 'awebchatbot_settings';

function awebchatbot_get_settings() {
    $defaults = array(
        'base_url'       => '',
        'widget_key'     => '',
        'identify_users' => '1',
        'exclude_admins' => '0',
    );
    $saved = get_option(AWEBCHATBOT_OPTION, array());
    return wp_parse_args(is_array($saved) ? $saved : array(), $defaults);
}

/* -------------------------------------------------------------------------- */
/* Front end                                                                  */
/* -------------------------------------------------------------------------- */

add_action('wp_footer', function () {
    $s = awebchatbot_get_settings();
    if (empty($s['base_url']) || empty($s['widget_key'])) {
        return;
    }
    if ($s['exclude_admins'] === '1' && current_user_can('manage_options')) {
        return;
    }
    $src = esc_url(rtrim($s['base_url'], '/') . '/widget.js');
    printf('<script src="%s" data-key="%s" async></script>' . "\n", $src, esc_attr($s['widget_key']));

    if ($s['identify_users'] === '1' && is_user_logged_in()) {
        $user = wp_get_current_user();
        $payload = wp_json_encode(array(
            'name'       => $user->display_name,
            'email'      => $user->user_email,
            'attributes' => array('wp_user_id' => (string) $user->ID),
        ));
        echo '<script>window.addEventListener("awebchatbot:ready",function(){window.AWebChatbot.identify(' . $payload . ');});</script>' . "\n";
    }
}, 100);

/* -------------------------------------------------------------------------- */
/* Settings page                                                              */
/* -------------------------------------------------------------------------- */

add_action('admin_menu', function () {
    add_options_page('AWebChatbot', 'AWebChatbot', 'manage_options', 'awebchatbot', 'awebchatbot_render_settings_page');
});

add_action('admin_init', function () {
    register_setting('awebchatbot', AWEBCHATBOT_OPTION, array(
        'type'              => 'array',
        'sanitize_callback' => function ($input) {
            $input = is_array($input) ? $input : array();
            return array(
                'base_url'       => esc_url_raw(trim($input['base_url'] ?? '')),
                'widget_key'     => preg_replace('/[^a-z0-9_]/', '', strtolower($input['widget_key'] ?? '')),
                'identify_users' => !empty($input['identify_users']) ? '1' : '0',
                'exclude_admins' => !empty($input['exclude_admins']) ? '1' : '0',
            );
        },
    ));
});

function awebchatbot_render_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    $s = awebchatbot_get_settings();
    ?>
    <div class="wrap">
        <h1>AWebChatbot</h1>
        <p>Paste your Worker URL and widget key (shown in the AWebChatbot inbox under <strong>Settings → Install</strong>, or ask Claude for <code>get_widget_install_code</code>).</p>
        <form method="post" action="options.php">
            <?php settings_fields('awebchatbot'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="awc_base">Worker URL</label></th>
                    <td><input id="awc_base" class="regular-text" type="url" name="<?php echo esc_attr(AWEBCHATBOT_OPTION); ?>[base_url]" value="<?php echo esc_attr($s['base_url']); ?>" placeholder="https://awebchatbot.your-subdomain.workers.dev"></td>
                </tr>
                <tr>
                    <th scope="row"><label for="awc_key">Widget key</label></th>
                    <td><input id="awc_key" class="regular-text" type="text" name="<?php echo esc_attr(AWEBCHATBOT_OPTION); ?>[widget_key]" value="<?php echo esc_attr($s['widget_key']); ?>" placeholder="pk_..."></td>
                </tr>
                <tr>
                    <th scope="row">Options</th>
                    <td>
                        <label><input type="checkbox" name="<?php echo esc_attr(AWEBCHATBOT_OPTION); ?>[identify_users]" value="1" <?php checked($s['identify_users'], '1'); ?>> Identify logged-in users (name and email) in the inbox</label><br>
                        <label><input type="checkbox" name="<?php echo esc_attr(AWEBCHATBOT_OPTION); ?>[exclude_admins]" value="1" <?php checked($s['exclude_admins'], '1'); ?>> Hide the widget for administrators</label>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=awebchatbot')) . '">Settings</a>');
    return $links;
});
